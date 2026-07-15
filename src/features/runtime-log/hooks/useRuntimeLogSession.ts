import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalOutputEvent } from "../../../services/events";
import {
  subscribeRuntimeLogExited,
  subscribeRuntimeLogStatus,
  subscribeTerminalOutput,
} from "../../../services/events";
import {
  closeTerminalSession,
  openTerminalSession,
  runtimeLogDetectProfiles,
  runtimeLogGetSession,
  runtimeLogMarkExit,
  runtimeLogStart,
  runtimeLogStop,
  type RuntimeProfileDescriptor,
  type RuntimeLogSessionSnapshot,
  type RuntimeLogSessionStatus,
  writeTerminalSession,
} from "../../../services/tauri";
import type { WorkspaceInfo } from "../../../types";
import { isWindowsPlatform } from "../../../utils/platform";

const RUNTIME_TERMINAL_ID = "runtime-console";
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const MAX_LOG_LINES = 5000;
const EXIT_CODE_PATTERN = /\[(?:CodePort|ccgui|CodeMoss) Run\] __EXIT__:(-?\d+)/;
const IS_WINDOWS_RUNTIME = isWindowsPlatform();

export type RuntimeConsoleStatus = "idle" | "starting" | "running" | "stopped" | "error";
export type RuntimeCommandPresetId =
  | "auto"
  | "java-maven"
  | "java-gradle"
  | "node-dev"
  | "node-start"
  | "python-main"
  | "go-run"
  | "custom";

type UseRuntimeLogSessionOptions = {
  activeWorkspace: WorkspaceInfo | null;
};

type RuntimeWorkspaceSession = {
  visible: boolean;
  status: RuntimeConsoleStatus;
  commandPreview: string | null;
  commandPresetId: RuntimeCommandPresetId;
  commandInput: string;
  log: string;
  error: string | null;
  truncated: boolean;
  exitCode: number | null;
  autoScroll: boolean;
  wrapLines: boolean;
};

export type RuntimeLogSessionState = {
  onOpenRuntimeConsole: () => void;
  onSelectRuntimeCommandPreset: (presetId: RuntimeCommandPresetId) => void;
  onChangeRuntimeCommandInput: (value: string) => void;
  onRunProject: () => Promise<void>;
  onStopProject: () => Promise<void>;
  onClearRuntimeLogs: () => void;
  onCopyRuntimeLogs: () => Promise<void>;
  onToggleRuntimeAutoScroll: () => void;
  onToggleRuntimeWrapLines: () => void;
  onCloseRuntimeConsole: () => void;
  runtimeAutoScroll: boolean;
  runtimeWrapLines: boolean;
  runtimeConsoleVisible: boolean;
  runtimeConsoleStatus: RuntimeConsoleStatus;
  runtimeConsoleCommandPreview: string | null;
  runtimeCommandPresetOptions: RuntimeCommandPresetId[];
  runtimeCommandPresetId: RuntimeCommandPresetId;
  runtimeCommandInput: string;
  runtimeConsoleLog: string;
  runtimeConsoleError: string | null;
  runtimeConsoleTruncated: boolean;
  runtimeConsoleExitCode: number | null;
};

const DEFAULT_SESSION: RuntimeWorkspaceSession = {
  visible: false,
  status: "idle",
  commandPreview: null,
  commandPresetId: "auto",
  commandInput: "",
  log: "",
  error: null,
  truncated: false,
  exitCode: null,
  autoScroll: true,
  wrapLines: true,
};

function normalizeProfilePresetId(rawId: string | null | undefined): RuntimeCommandPresetId | null {
  switch (rawId) {
    case "java-maven":
    case "java-gradle":
    case "node-dev":
    case "node-start":
    case "python-main":
    case "go-run":
      return rawId;
    default:
      return null;
  }
}

function resolveCommandPresetId(
  command: string,
  detectedProfiles: RuntimeProfileDescriptor[],
  profileId?: string | null,
): RuntimeCommandPresetId {
  const matchedProfileId = normalizeProfilePresetId(profileId);
  if (matchedProfileId) {
    return matchedProfileId;
  }
  const normalized = command.trim();
  if (!normalized) {
    return "auto";
  }
  const matchedProfile = detectedProfiles.find(
    (profile) => profile.defaultCommand.trim() === normalized,
  );
  const matchedDetectedId = normalizeProfilePresetId(matchedProfile?.id);
  return matchedDetectedId ?? "custom";
}

function appendRuntimeLog(
  current: string,
  chunk: string,
): { next: string; truncated: boolean } {
  const merged = current + chunk;
  const segments = merged.split("\n");
  const maxSegments = MAX_LOG_LINES + 1;
  if (segments.length <= maxSegments) {
    return { next: merged, truncated: false };
  }
  return {
    next: segments.slice(segments.length - maxSegments).join("\n"),
    truncated: true,
  };
}

function mapRuntimeStatus(status: RuntimeLogSessionStatus): RuntimeConsoleStatus {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "running";
    case "stopped":
      return "stopped";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function applyRuntimeSnapshot(
  current: RuntimeWorkspaceSession,
  snapshot: RuntimeLogSessionSnapshot,
  detectedProfiles: RuntimeProfileDescriptor[],
): RuntimeWorkspaceSession {
  const mappedStatus = mapRuntimeStatus(snapshot.status);
  const nextCommandInput =
    current.commandInput.trim().length === 0 && snapshot.commandPreview
      ? snapshot.commandPreview
      : current.commandInput;
  return {
    ...current,
    visible: mappedStatus !== "idle",
    status: mappedStatus,
    commandPreview: snapshot.commandPreview,
    commandInput: nextCommandInput,
    commandPresetId: resolveCommandPresetId(
      nextCommandInput,
      detectedProfiles,
      snapshot.profileId,
    ),
    exitCode: snapshot.exitCode ?? current.exitCode,
    error: snapshot.error ?? null,
  };
}

function isMissingCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("runtime_log_start") ||
    error.message.includes("runtime_log_stop") ||
    error.message.includes("runtime_log_mark_exit") ||
    error.message.includes("unknown command")
  );
}

function buildLegacyJavaRunScript(commandOverride?: string | null) {
  if (IS_WINDOWS_RUNTIME) {
    const normalizedOverride = commandOverride?.trim() ?? "";
    if (normalizedOverride) {
      return [
        "@echo off",
        "setlocal EnableExtensions EnableDelayedExpansion",
        "set \"CCGUI_RUN_EXIT_CODE=0\"",
        "where java >nul 2>&1",
        "if errorlevel 1 (",
        "  echo [CodePort Run] Java not found. Install JDK and ensure java is on PATH.",
        "  set \"CCGUI_RUN_EXIT_CODE=127\"",
        ") else (",
        "  echo [CodePort Run] Using custom run command from console.",
        `  ${normalizedOverride}`,
        "  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
        ")",
        "echo [CodePort Run] __EXIT__:!CCGUI_RUN_EXIT_CODE!",
      ].join("\r\n");
    }

    return [
      "@echo off",
      "setlocal EnableExtensions EnableDelayedExpansion",
      "set \"CCGUI_RUN_EXIT_CODE=0\"",
      "echo [CodePort Run] Detecting Java launcher...",
      "where java >nul 2>&1",
      "if errorlevel 1 (",
      "  echo [CodePort Run] Java not found. Install JDK and ensure java is on PATH.",
      "  set \"CCGUI_RUN_EXIT_CODE=127\"",
      ") else if exist \"mvnw.cmd\" if exist \"pom.xml\" (",
      "  echo [CodePort Run] Using: mvnw.cmd spring-boot:run",
      "  call mvnw.cmd spring-boot:run",
      "  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      ") else if exist \"pom.xml\" (",
      "  where mvn >nul 2>&1",
      "  if errorlevel 1 (",
      "    echo [CodePort Run] Maven not found. Install Maven or add mvnw.cmd to project root.",
      "    set \"CCGUI_RUN_EXIT_CODE=127\"",
      "  ) else (",
      "    echo [CodePort Run] Using: mvn spring-boot:run",
      "    call mvn spring-boot:run",
      "    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      "  )",
      ") else if exist \"gradlew.bat\" if exist \"build.gradle\" (",
      "  echo [CodePort Run] Using: gradlew.bat bootRun",
      "  call gradlew.bat bootRun",
      "  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      ") else if exist \"gradlew.bat\" if exist \"build.gradle.kts\" (",
      "  echo [CodePort Run] Using: gradlew.bat bootRun",
      "  call gradlew.bat bootRun",
      "  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      ") else if exist \"build.gradle\" (",
      "  where gradle >nul 2>&1",
      "  if errorlevel 1 (",
      "    echo [CodePort Run] Gradle not found. Install Gradle or add gradlew.bat to project root.",
      "    set \"CCGUI_RUN_EXIT_CODE=127\"",
      "  ) else (",
      "    echo [CodePort Run] Using: gradle bootRun",
      "    call gradle bootRun",
      "    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      "  )",
      ") else if exist \"build.gradle.kts\" (",
      "  where gradle >nul 2>&1",
      "  if errorlevel 1 (",
      "    echo [CodePort Run] Gradle not found. Install Gradle or add gradlew.bat to project root.",
      "    set \"CCGUI_RUN_EXIT_CODE=127\"",
      "  ) else (",
      "    echo [CodePort Run] Using: gradle bootRun",
      "    call gradle bootRun",
      "    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"",
      "  )",
      ") else (",
      "  echo [CodePort Run] No Java project launcher detected in workspace root.",
      "  echo [CodePort Run] Expected one of: pom.xml, build.gradle, build.gradle.kts.",
      "  set \"CCGUI_RUN_EXIT_CODE=127\"",
      ")",
      "echo [CodePort Run] __EXIT__:!CCGUI_RUN_EXIT_CODE!",
    ].join("\r\n");
  }

  const normalizedOverride = commandOverride?.trim() ?? "";
  if (normalizedOverride) {
    return [
      "CCGUI_RUN_EXIT_CODE=0",
      "if ! command -v java >/dev/null 2>&1; then",
      "  echo \"[CodePort Run] Java not found. Install JDK and ensure java is on PATH.\"",
      "  CCGUI_RUN_EXIT_CODE=127",
      "else",
      "  echo \"[CodePort Run] Using custom run command from console.\"",
      `  ${normalizedOverride}`,
      "  CCGUI_RUN_EXIT_CODE=$?",
      "fi",
      "echo \"[CodePort Run] __EXIT__:${CCGUI_RUN_EXIT_CODE}\"",
    ].join("\n");
  }

  return [
    "CCGUI_RUN_EXIT_CODE=0",
    "echo \"[CodePort Run] Detecting Java launcher...\"",
    "if ! command -v java >/dev/null 2>&1; then",
    "  echo \"[CodePort Run] Java not found. Install JDK and ensure java is on PATH.\"",
    "  CCGUI_RUN_EXIT_CODE=127",
    "elif [ -f \"./mvnw\" ] && [ -f \"./pom.xml\" ]; then",
    "  echo \"[CodePort Run] Using: ./mvnw spring-boot:run\"",
    "  ./mvnw spring-boot:run",
    "  CCGUI_RUN_EXIT_CODE=$?",
    "elif [ -f \"./pom.xml\" ]; then",
    "  if command -v mvn >/dev/null 2>&1; then",
    "    echo \"[CodePort Run] Using: mvn spring-boot:run\"",
    "    mvn spring-boot:run",
    "    CCGUI_RUN_EXIT_CODE=$?",
    "  else",
    "    echo \"[CodePort Run] Maven not found. Install Maven or add ./mvnw to project root.\"",
    "    CCGUI_RUN_EXIT_CODE=127",
    "  fi",
    "elif [ -f \"./gradlew\" ] && { [ -f \"./build.gradle\" ] || [ -f \"./build.gradle.kts\" ]; }; then",
    "  echo \"[CodePort Run] Using: ./gradlew bootRun\"",
    "  ./gradlew bootRun",
    "  CCGUI_RUN_EXIT_CODE=$?",
    "elif [ -f \"./build.gradle\" ] || [ -f \"./build.gradle.kts\" ]; then",
    "  if command -v gradle >/dev/null 2>&1; then",
    "    echo \"[CodePort Run] Using: gradle bootRun\"",
    "    gradle bootRun",
    "    CCGUI_RUN_EXIT_CODE=$?",
    "  else",
    "    echo \"[CodePort Run] Gradle not found. Install Gradle or add ./gradlew to project root.\"",
    "    CCGUI_RUN_EXIT_CODE=127",
    "  fi",
    "else",
    "  echo \"[CodePort Run] No Java project launcher detected in workspace root.\"",
    "  echo \"[CodePort Run] Expected one of: pom.xml, build.gradle, build.gradle.kts.\"",
    "  CCGUI_RUN_EXIT_CODE=127",
    "fi",
    "echo \"[CodePort Run] __EXIT__:${CCGUI_RUN_EXIT_CODE}\"",
  ].join("\n");
}

export function useRuntimeLogSession({
  activeWorkspace,
}: UseRuntimeLogSessionOptions): RuntimeLogSessionState {
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const [sessionByWorkspace, setSessionByWorkspace] = useState<
    Record<string, RuntimeWorkspaceSession>
  >({});
  const [detectedProfilesByWorkspace, setDetectedProfilesByWorkspace] = useState<
    Record<string, RuntimeProfileDescriptor[]>
  >({});
  const exitBufferByWorkspaceRef = useRef<Record<string, string>>({});
  const detectedProfilesByWorkspaceRef = useRef<Record<string, RuntimeProfileDescriptor[]>>({});
  const pendingChunkByWorkspaceRef = useRef<Map<string, string>>(new Map());
  const flushScheduledRef = useRef(false);
  const rafHandleRef = useRef<number | null>(null);
  const timeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    detectedProfilesByWorkspaceRef.current = detectedProfilesByWorkspace;
  }, [detectedProfilesByWorkspace]);

  const updateWorkspaceSession = useCallback(
    (workspaceId: string, updater: (current: RuntimeWorkspaceSession) => RuntimeWorkspaceSession) => {
      setSessionByWorkspace((prev) => {
        const current = prev[workspaceId] ?? DEFAULT_SESSION;
        const next = updater(current);
        return { ...prev, [workspaceId]: next };
      });
    },
    [],
  );
  const getDetectedProfiles = useCallback(
    (workspaceId: string) => detectedProfilesByWorkspaceRef.current[workspaceId] ?? [],
    [],
  );

  const appendWorkspaceLog = useCallback(
    (workspaceId: string, chunk: string) => {
      updateWorkspaceSession(workspaceId, (current) => {
        const { next, truncated } = appendRuntimeLog(current.log, chunk);
        return {
          ...current,
          log: next,
          truncated: current.truncated || truncated,
        };
      });
    },
    [updateWorkspaceSession],
  );

  const consumeExitCode = useCallback((workspaceId: string, chunk: string) => {
    const buffers = exitBufferByWorkspaceRef.current;
    const pending = `${buffers[workspaceId] ?? ""}${chunk}`;
    const lines = pending.split("\n");
    buffers[workspaceId] = lines.pop() ?? "";

    let exitCode: number | null = null;
    for (const line of lines) {
      const match = line.match(EXIT_CODE_PATTERN);
      if (!match) {
        continue;
      }
      const parsed = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isNaN(parsed)) {
        exitCode = parsed;
      }
    }
    return exitCode;
  }, []);

  const flushPendingChunks = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    flushScheduledRef.current = false;
    rafHandleRef.current = null;
    timeoutHandleRef.current = null;

    const pendingChunks = pendingChunkByWorkspaceRef.current;
    if (pendingChunks.size === 0) {
      return;
    }

    const chunksByWorkspace = new Map(pendingChunks);
    pendingChunks.clear();

    for (const [workspaceId, data] of chunksByWorkspace) {
      appendWorkspaceLog(workspaceId, data);

      const exitCode = consumeExitCode(workspaceId, data);
      if (exitCode !== null) {
        updateWorkspaceSession(workspaceId, (current) => ({
          ...current,
          visible: true,
          exitCode,
          status: exitCode === 0 ? "stopped" : "error",
          error: exitCode === 0 ? null : `Process exited with code ${exitCode}.`,
        }));
        void runtimeLogMarkExit(workspaceId, exitCode).catch(() => undefined);
        continue;
      }

      updateWorkspaceSession(workspaceId, (current) => ({
        ...current,
        visible: true,
        status:
          current.status === "starting" || current.status === "idle" || current.status === "stopped"
            ? "running"
            : current.status,
      }));
    }
  }, [appendWorkspaceLog, consumeExitCode, updateWorkspaceSession]);

  const schedulePendingChunkFlush = useCallback(() => {
    if (flushScheduledRef.current) {
      return;
    }

    flushScheduledRef.current = true;
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      rafHandleRef.current = window.requestAnimationFrame(() => {
        flushPendingChunks();
      });
      return;
    }

    timeoutHandleRef.current = setTimeout(flushPendingChunks, 0);
  }, [flushPendingChunks]);

  useEffect(() => {
    mountedRef.current = true;
    const pendingChunks = pendingChunkByWorkspaceRef.current;
    const unsubscribe = subscribeTerminalOutput((event: TerminalOutputEvent) => {
      if (
        event.terminalId !== RUNTIME_TERMINAL_ID ||
        !event.workspaceId ||
        event.data.length === 0
      ) {
        return;
      }

      const currentChunk = pendingChunks.get(event.workspaceId) ?? "";
      pendingChunks.set(event.workspaceId, `${currentChunk}${event.data}`);
      schedulePendingChunkFlush();
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (
        rafHandleRef.current !== null &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(rafHandleRef.current);
      }
      if (timeoutHandleRef.current !== null) {
        clearTimeout(timeoutHandleRef.current);
      }
      rafHandleRef.current = null;
      timeoutHandleRef.current = null;
      flushScheduledRef.current = false;
      pendingChunks.clear();
    };
  }, [schedulePendingChunkFlush]);

  useEffect(() => {
    const unsubscribeStatus = subscribeRuntimeLogStatus((event) => {
      updateWorkspaceSession(event.workspaceId, (current) =>
        applyRuntimeSnapshot(current, event, getDetectedProfiles(event.workspaceId)),
      );
    });
    const unsubscribeExited = subscribeRuntimeLogExited((event) => {
      updateWorkspaceSession(event.workspaceId, (current) =>
        applyRuntimeSnapshot(current, event, getDetectedProfiles(event.workspaceId)),
      );
    });

    return () => {
      unsubscribeStatus();
      unsubscribeExited();
    };
  }, [getDetectedProfiles, updateWorkspaceSession]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    let cancelled = false;
    runtimeLogDetectProfiles(activeWorkspaceId)
      .then((profiles) => {
        if (cancelled) {
          return;
        }
        setDetectedProfilesByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: profiles,
        }));
        updateWorkspaceSession(activeWorkspaceId, (current) => ({
          ...current,
          commandPresetId: resolveCommandPresetId(current.commandInput, profiles),
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setDetectedProfilesByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: [],
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, updateWorkspaceSession]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    let cancelled = false;
    runtimeLogGetSession(activeWorkspaceId)
      .then((snapshot) => {
        if (cancelled || !snapshot) {
          return;
        }
        updateWorkspaceSession(activeWorkspaceId, (current) =>
          applyRuntimeSnapshot(
            current,
            snapshot,
            detectedProfilesByWorkspaceRef.current[activeWorkspaceId] ?? [],
          ),
        );
      })
      .catch(() => {
        // Ignore runtime session restore failures.
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, updateWorkspaceSession]);

  const activeDetectedProfiles = useMemo(
    () => (activeWorkspaceId ? detectedProfilesByWorkspace[activeWorkspaceId] ?? [] : []),
    [activeWorkspaceId, detectedProfilesByWorkspace],
  );

  const onSelectRuntimeCommandPreset = useCallback(
    (presetId: RuntimeCommandPresetId) => {
      if (!activeWorkspaceId) {
        return;
      }
      updateWorkspaceSession(activeWorkspaceId, (current) => {
        if (presetId === "custom") {
          return {
            ...current,
            commandPresetId: "custom",
          };
        }
        if (presetId === "auto") {
          return {
            ...current,
            commandPresetId: "auto",
            commandInput: "",
          };
        }
        const selectedProfile = activeDetectedProfiles.find((profile) => profile.id === presetId);
        if (!selectedProfile) {
          return current;
        }
        return {
          ...current,
          commandPresetId: presetId,
          commandInput: selectedProfile.defaultCommand,
        };
      });
    },
    [activeDetectedProfiles, activeWorkspaceId, updateWorkspaceSession],
  );

  const onChangeRuntimeCommandInput = useCallback(
    (value: string) => {
      if (!activeWorkspaceId) {
        return;
      }
      updateWorkspaceSession(activeWorkspaceId, (current) => ({
        ...current,
        commandInput: value,
        commandPresetId: resolveCommandPresetId(value, activeDetectedProfiles),
      }));
    },
    [activeDetectedProfiles, activeWorkspaceId, updateWorkspaceSession],
  );

  const activeSession = useMemo<RuntimeWorkspaceSession>(() => {
    if (!activeWorkspaceId) {
      return DEFAULT_SESSION;
    }
    return sessionByWorkspace[activeWorkspaceId] ?? DEFAULT_SESSION;
  }, [activeWorkspaceId, sessionByWorkspace]);

  const runtimeCommandPresetOptions = useMemo<RuntimeCommandPresetId[]>(() => {
    const detectedIds = activeDetectedProfiles
      .map((profile) => normalizeProfilePresetId(profile.id))
      .filter((value): value is Exclude<RuntimeCommandPresetId, "auto" | "custom"> => value !== null);
    return ["auto", ...Array.from(new Set(detectedIds)), "custom"];
  }, [activeDetectedProfiles]);

  const onRunProject = useCallback(async () => {
    const workspaceId = activeWorkspace?.id;
    if (!workspaceId) {
      return;
    }
    const normalizedInput = activeSession.commandInput.trim();
    const selectedProfile =
      activeDetectedProfiles.find(
        (profile) => normalizeProfilePresetId(profile.id) === activeSession.commandPresetId,
      ) ?? null;
    const selectedDefaultCommand = selectedProfile?.defaultCommand.trim() ?? "";
    const shouldUseDetectedProfile =
      Boolean(selectedProfile) &&
      activeSession.commandPresetId !== "auto" &&
      activeSession.commandPresetId !== "custom" &&
      (normalizedInput.length === 0 || normalizedInput === selectedDefaultCommand);
    const profileId = shouldUseDetectedProfile ? selectedProfile?.id ?? null : null;
    const commandOverride =
      normalizedInput.length > 0 && !shouldUseDetectedProfile
        ? normalizedInput
        : null;
    exitBufferByWorkspaceRef.current[workspaceId] = "";
    updateWorkspaceSession(workspaceId, (current) => ({
      ...current,
      visible: true,
      status: "starting",
      commandPreview: null,
      error: null,
      exitCode: null,
      truncated: false,
      autoScroll: true,
    }));
    appendWorkspaceLog(
      workspaceId,
      `\n[CodePort Run] Starting at ${new Date().toLocaleTimeString()}\n`,
    );
    try {
      const snapshot = await runtimeLogStart(workspaceId, {
        profileId,
        commandOverride,
      });
      updateWorkspaceSession(workspaceId, (current) => ({
        ...applyRuntimeSnapshot(current, snapshot, activeDetectedProfiles),
        visible: true,
        status: "running",
      }));
    } catch (error) {
      if (isMissingCommandError(error)) {
        try {
          await closeTerminalSession(workspaceId, RUNTIME_TERMINAL_ID).catch(() => undefined);
          await openTerminalSession(
            workspaceId,
            RUNTIME_TERMINAL_ID,
            DEFAULT_TERMINAL_COLS,
            DEFAULT_TERMINAL_ROWS,
          );
          await writeTerminalSession(
            workspaceId,
            RUNTIME_TERMINAL_ID,
            `${buildLegacyJavaRunScript(commandOverride)}\n`,
          );
          updateWorkspaceSession(workspaceId, (current) => ({
            ...current,
            status: "running",
            commandPreview:
              commandOverride && commandOverride.length > 0 ? commandOverride : current.commandPreview,
          }));
          return;
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          updateWorkspaceSession(workspaceId, (current) => ({
            ...current,
            status: "error",
            error: fallbackMessage,
          }));
          appendWorkspaceLog(
            workspaceId,
            `[CodePort Run] Failed to start runtime: ${fallbackMessage}\n`,
          );
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      updateWorkspaceSession(workspaceId, (current) => ({
        ...current,
        status: "error",
        error: message,
      }));
      appendWorkspaceLog(
        workspaceId,
        `[CodePort Run] Failed to start runtime: ${message}\n`,
      );
    }
  }, [
    activeDetectedProfiles,
    activeSession.commandInput,
    activeSession.commandPresetId,
    activeWorkspace?.id,
    appendWorkspaceLog,
    updateWorkspaceSession,
  ]);

  const onOpenRuntimeConsole = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    updateWorkspaceSession(activeWorkspaceId, (current) => ({
      ...current,
      visible: true,
    }));
  }, [activeWorkspaceId, updateWorkspaceSession]);

  const onStopProject = useCallback(async () => {
    const workspaceId = activeWorkspace?.id;
    if (!workspaceId) {
      return;
    }
    try {
      const snapshot = await runtimeLogStop(workspaceId);
      updateWorkspaceSession(workspaceId, (current) => ({
        ...applyRuntimeSnapshot(current, snapshot, getDetectedProfiles(workspaceId)),
        status: "stopped",
      }));
      appendWorkspaceLog(workspaceId, "[CodePort Run] Stopped.\n");
    } catch (error) {
      if (isMissingCommandError(error)) {
        try {
          await closeTerminalSession(workspaceId, RUNTIME_TERMINAL_ID);
          updateWorkspaceSession(workspaceId, (current) => ({
            ...current,
            status: "stopped",
            exitCode: current.exitCode === null ? 130 : current.exitCode,
          }));
          appendWorkspaceLog(workspaceId, "[CodePort Run] Stopped.\n");
          return;
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          updateWorkspaceSession(workspaceId, (current) => ({
            ...current,
            status: "error",
            error: fallbackMessage,
          }));
          appendWorkspaceLog(
            workspaceId,
            `[CodePort Run] Stop failed: ${fallbackMessage}\n`,
          );
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      updateWorkspaceSession(workspaceId, (current) => ({
        ...current,
        status: "error",
        error: message,
      }));
      appendWorkspaceLog(
        workspaceId,
        `[CodePort Run] Stop failed: ${message}\n`,
      );
    }
  }, [activeWorkspace?.id, appendWorkspaceLog, getDetectedProfiles, updateWorkspaceSession]);

  const onClearRuntimeLogs = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    updateWorkspaceSession(activeWorkspaceId, (current) => ({
      ...current,
      log: "",
      truncated: false,
    }));
  }, [activeWorkspaceId, updateWorkspaceSession]);

  const onCopyRuntimeLogs = useCallback(async () => {
    if (!activeSession.log) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activeSession.log);
    } catch {
      // Ignore clipboard failures in restricted contexts.
    }
  }, [activeSession.log]);

  const onToggleRuntimeAutoScroll = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    updateWorkspaceSession(activeWorkspaceId, (current) => ({
      ...current,
      autoScroll: !current.autoScroll,
    }));
  }, [activeWorkspaceId, updateWorkspaceSession]);

  const onToggleRuntimeWrapLines = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    updateWorkspaceSession(activeWorkspaceId, (current) => ({
      ...current,
      wrapLines: !current.wrapLines,
    }));
  }, [activeWorkspaceId, updateWorkspaceSession]);

  const onCloseRuntimeConsole = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    updateWorkspaceSession(activeWorkspaceId, (current) => ({
      ...current,
      visible: false,
    }));
  }, [activeWorkspaceId, updateWorkspaceSession]);

  return useMemo<RuntimeLogSessionState>(
    () => ({
      onOpenRuntimeConsole,
      onSelectRuntimeCommandPreset,
      onChangeRuntimeCommandInput,
      onRunProject,
      onStopProject,
      onClearRuntimeLogs,
      onCopyRuntimeLogs,
      onToggleRuntimeAutoScroll,
      onToggleRuntimeWrapLines,
      onCloseRuntimeConsole,
      runtimeAutoScroll: activeSession.autoScroll,
      runtimeWrapLines: activeSession.wrapLines,
      runtimeConsoleVisible: activeSession.visible,
      runtimeConsoleStatus: activeSession.status,
      runtimeConsoleCommandPreview: activeSession.commandPreview,
      runtimeCommandPresetOptions,
      runtimeCommandPresetId: activeSession.commandPresetId,
      runtimeCommandInput: activeSession.commandInput,
      runtimeConsoleLog: activeSession.log,
      runtimeConsoleError: activeSession.error,
      runtimeConsoleTruncated: activeSession.truncated,
      runtimeConsoleExitCode: activeSession.exitCode,
    }),
    [
      onOpenRuntimeConsole,
      onSelectRuntimeCommandPreset,
      onChangeRuntimeCommandInput,
      onRunProject,
      onStopProject,
      onClearRuntimeLogs,
      onCopyRuntimeLogs,
      onToggleRuntimeAutoScroll,
      onToggleRuntimeWrapLines,
      onCloseRuntimeConsole,
      activeSession.autoScroll,
      activeSession.wrapLines,
      activeSession.visible,
      activeSession.status,
      activeSession.commandPreview,
      runtimeCommandPresetOptions,
      activeSession.commandPresetId,
      activeSession.commandInput,
      activeSession.log,
      activeSession.error,
      activeSession.truncated,
      activeSession.exitCode,
    ],
  );
}
