import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationItem,
  EngineType,
  MessageSendOptions,
  QueuedMessage,
  WorkspaceInfo,
} from "../../../types";
import {
  buildQueuedOptimisticUserMessageId,
  buildQueuedHandoffBubbleItem,
  hasCanonicalUserItemForQueuedHandoffBubble,
  type QueuedHandoffBubble,
} from "../utils/queuedHandoffBubble";

const OPENCODE_INFLIGHT_STALL_MS = 18_000;
const FUSION_RESUME_TIMEOUT_MS = 48_000;
const QUEUED_HANDOFF_BUBBLE_TTL_MS = 60_000;

type UseQueuedSendOptions = {
  activeThreadId: string | null;
  activeItems?: ConversationItem[];
  activeTurnId?: string | null;
  activeContinuationPulse?: number;
  activeTerminalPulse?: number;
  isProcessing: boolean;
  isReviewing: boolean;
  // True while an AskUserQuestion dialog is open for the active thread. The CLI
  // turn is blocked awaiting the answer, so the queue must NOT flush into it —
  // isProcessing can drop to false mid-ask, which would otherwise send queued
  // messages as fresh turns and strand the pending answer. See handleSend +
  // the auto-flush effect below.
  hasPendingUserInput?: boolean;
  steerEnabled: boolean;
  activeWorkspace: WorkspaceInfo | null;
  activeEngine?: EngineType;
  resolveCanonicalThreadId: (threadId: string) => string;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (
    workspaceId: string,
    options?: { activate?: boolean; engine?: EngineType; folderId?: string | null },
  ) => Promise<string | null>;
  sendUserMessage: (
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  startFork: (text: string, options?: MessageSendOptions) => Promise<void>;
  startReview: (text: string) => Promise<void>;
  startResume: (text: string) => Promise<void>;
  startMcp: (text: string) => Promise<void>;
  startSpecRoot: (text: string) => Promise<void>;
  startStatus: (text: string) => Promise<void>;
  startContext: (text: string) => Promise<void>;
  startExport: (text: string) => Promise<void>;
  startImport: (text: string) => Promise<void>;
  startLsp: (text: string) => Promise<void>;
  startShare: (text: string) => Promise<void>;
  startCompact: (text: string) => Promise<void>;
  startFast: (text: string) => Promise<void>;
  startMode: (text: string) => Promise<void>;
  setCodexCollaborationMode?: (mode: "plan" | "code") => void;
  getCodexCollaborationMode?: () => "plan" | "code" | null;
  getCodexCollaborationPayload?: () => Record<string, unknown> | null;
  interruptTurn?: (options?: {
    reason?: "user-stop" | "queue-fusion";
  }) => Promise<void>;
  handleFusionStalled?: (
    threadId: string,
    options?: { message?: string | null },
  ) => void;
  clearActiveImages: () => void;
};

type UseQueuedSendResult = {
  queuedByThread: Record<string, QueuedMessage[]>;
  activeQueue: QueuedMessage[];
  activeQueuedHandoffBubble: QueuedHandoffBubble | null;
  handleSend: (
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  queueMessage: (
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  removeQueuedMessage: (threadId: string, messageId: string) => void;
  fuseQueuedMessage: (threadId: string, messageId: string) => Promise<void>;
  canFuseActiveQueue: boolean;
  activeFusingMessageId: string | null;
};

type ThreadFusionState = {
  messageId: string;
  turnIdBeforeFusion: string | null;
  mode: "same-run" | "cutover";
  stage: "dispatching" | "awaiting-continuation";
  startedAtMs: number;
  continuationPulseAtStart: number;
  terminalPulseAtStart: number;
};

type SlashCommandKind =
  | "fork"
  | "fast"
  | "clear"
  | "mcp"
  | "new"
  | "resume"
  | "specRoot"
  | "review"
  | "status"
  | "context"
  | "export"
  | "import"
  | "lsp"
  | "share"
  | "compact"
  | "plan"
  | "defaultMode"
  | "code"
  | "mode";

const MODE_QUERY_DENYLIST =
  /(区别|差别|不同|怎么|如何|为什么|为何|影响|不影响|约束|规则|行为|能力|planfirst|agents\.?md)/i;

function readSlashCommandToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const withoutSlash = trimmed.slice(1);
  if (!withoutSlash) {
    return null;
  }
  const firstToken = withoutSlash.split(/\s+/, 1)[0]?.trim();
  if (!firstToken) {
    return null;
  }
  return firstToken.toLowerCase();
}

function isImplicitModeQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) {
    return false;
  }
  if (MODE_QUERY_DENYLIST.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (
    /^(?:mode|current\s+mode|what(?:'s| is)\s+(?:the\s+)?(?:current\s+)?mode|am i in (?:plan|default) mode)\s*[?]?$/i
      .test(normalized)
  ) {
    return true;
  }
  if (/^(现在呢|当前呢|此时呢)\s*[？?]?$/u.test(trimmed)) {
    return true;
  }
  return /^(现在|当前|此时).{0,24}(模式|计划模式|default|默认).{0,24}(吗|呢)?\s*[？?]?$/u
    .test(trimmed);
}

function parseSlashCommand(text: string): SlashCommandKind | null {
  const commandToken = readSlashCommandToken(text);
  if (commandToken === "fork") {
    return "fork";
  }
  if (commandToken === "fast") {
    return "fast";
  }
  if (commandToken === "clear" || commandToken === "reset") {
    return "clear";
  }
  if (commandToken === "mcp") {
    return "mcp";
  }
  if (commandToken === "review") {
    return "review";
  }
  if (commandToken === "new") {
    return "new";
  }
  if (commandToken === "resume") {
    return "resume";
  }
  if (commandToken === "spec-root") {
    return "specRoot";
  }
  if (commandToken === "status") {
    return "status";
  }
  if (commandToken === "context") {
    return "context";
  }
  if (commandToken === "export") {
    return "export";
  }
  if (commandToken === "import") {
    return "import";
  }
  if (commandToken === "lsp") {
    return "lsp";
  }
  if (commandToken === "share") {
    return "share";
  }
  if (commandToken === "compact") {
    return "compact";
  }
  if (commandToken === "plan") {
    return "plan";
  }
  if (commandToken === "default") {
    return "defaultMode";
  }
  if (commandToken === "code") {
    return "code";
  }
  if (commandToken === "mode") {
    return "mode";
  }
  return null;
}

function isQueuedMessageFuseEligible(item: QueuedMessage): boolean {
  return readSlashCommandToken(item.text) === null;
}

function isCodexOnlyCommand(command: SlashCommandKind): boolean {
  return (
    command === "fast" ||
    command === "plan" ||
    command === "defaultMode" ||
    command === "code" ||
    command === "mode"
  );
}

function isClaudeOnlyCommand(command: SlashCommandKind): boolean {
  return command === "compact";
}

function canExecuteSlashCommand(
  command: SlashCommandKind | null,
  activeEngine: EngineType,
  activeThreadId: string | null,
): command is SlashCommandKind {
  if (!command) {
    return false;
  }
  if (command === "clear" && activeEngine !== "claude") {
    return false;
  }
  if (isCodexOnlyCommand(command) && activeEngine !== "codex") {
    return false;
  }
  if (isClaudeOnlyCommand(command)) {
    if (activeEngine === "claude") {
      return true;
    }
    return Boolean(
      activeThreadId &&
        (activeThreadId.startsWith("claude:")
          || activeThreadId.startsWith("claude-pending-")),
    );
  }
  return true;
}

export function useQueuedSend({
  activeThreadId,
  activeItems = [],
  activeTurnId,
  activeContinuationPulse = 0,
  activeTerminalPulse = 0,
  isProcessing,
  isReviewing,
  hasPendingUserInput = false,
  steerEnabled,
  activeWorkspace,
  activeEngine = "claude",
  resolveCanonicalThreadId,
  connectWorkspace,
  startThreadForWorkspace,
  sendUserMessage,
  sendUserMessageToThread,
  startFork,
  startReview,
  startResume,
  startMcp,
  startSpecRoot,
  startStatus,
  startContext,
  startExport,
  startImport,
  startLsp,
  startShare,
  startCompact,
  startFast,
  startMode,
  setCodexCollaborationMode,
  getCodexCollaborationMode,
  getCodexCollaborationPayload,
  interruptTurn,
  handleFusionStalled,
  clearActiveImages,
}: UseQueuedSendOptions): UseQueuedSendResult {
  const isClaudePendingBootstrapThread =
    activeEngine === "claude" && Boolean(activeThreadId?.startsWith("claude-pending-"));
  const [queuedByThread, setQueuedByThread] = useState<
    Record<string, QueuedMessage[]>
  >({});
  const [inFlightByThread, setInFlightByThread] = useState<
    Record<string, QueuedMessage | null>
  >({});
  const [queuedHandoffByThread, setQueuedHandoffByThread] = useState<
    Record<string, QueuedHandoffBubble | null>
  >({});
  const [hasStartedByThread, setHasStartedByThread] = useState<
    Record<string, boolean>
  >({});
  const [fusionByThread, setFusionByThread] = useState<
    Record<string, ThreadFusionState | null>
  >({});
  const previousActiveThreadIdRef = useRef<string | null>(activeThreadId);
  const activeItemsRef = useRef(activeItems);
  activeItemsRef.current = activeItems;

  const activeQueue = useMemo(
    () => (activeThreadId ? queuedByThread[activeThreadId] ?? [] : []),
    [activeThreadId, queuedByThread],
  );
  const activeFusion = useMemo(
    () => (activeThreadId ? fusionByThread[activeThreadId] ?? null : null),
    [activeThreadId, fusionByThread],
  );
  const activeQueuedHandoffBubble = useMemo(
    () => (activeThreadId ? queuedHandoffByThread[activeThreadId] ?? null : null),
    [activeThreadId, queuedHandoffByThread],
  );
  const activeFusingMessageId = activeFusion?.messageId ?? null;
  const canFuseActiveQueue = useMemo(
    () =>
      Boolean(
        activeThreadId &&
          activeWorkspace &&
          activeQueue.length > 0 &&
          !activeFusion &&
          !isClaudePendingBootstrapThread &&
          isProcessing &&
          !isReviewing &&
          (steerEnabled || interruptTurn),
      ),
    [
      activeFusion,
      activeQueue.length,
      activeThreadId,
      activeWorkspace,
      isClaudePendingBootstrapThread,
      interruptTurn,
      isProcessing,
      isReviewing,
      steerEnabled,
    ],
  );

  useEffect(() => {
    if (previousActiveThreadIdRef.current === activeThreadId) {
      return;
    }
    const oldThreadId = previousActiveThreadIdRef.current;
    const newThreadId = activeThreadId;
    previousActiveThreadIdRef.current = newThreadId;
    if (!oldThreadId || !newThreadId) {
      return;
    }
    const isClaudeSessionTransition =
      oldThreadId.startsWith("claude-pending-") && newThreadId.startsWith("claude:");
    // Optimistic codex threads rename from `codex-pending-*` to a bare
    // backend thread id (codex ids carry no engine prefix), so id shape alone
    // cannot distinguish the finalize rebind from the user manually switching
    // to another codex thread. Require the alias the finalize flow records
    // (onCodexPendingThreadFinalized -> rememberThreadAlias) to confirm that
    // newThreadId really is oldThreadId's finalized identity.
    const isCodexSessionTransition =
      oldThreadId.startsWith("codex-pending-") &&
      resolveCanonicalThreadId(oldThreadId) === newThreadId;
    if (!isClaudeSessionTransition && !isCodexSessionTransition) {
      return;
    }

    setQueuedByThread((prev) => {
      const pendingQueue = prev[oldThreadId] ?? [];
      if (pendingQueue.length < 1) {
        return prev;
      }
      const nextQueue = prev[newThreadId] ?? [];
      const next = {
        ...prev,
        [newThreadId]: [...pendingQueue, ...nextQueue],
      };
      delete next[oldThreadId];
      return next;
    });

    setInFlightByThread((prev) => {
      const pendingInFlight = prev[oldThreadId];
      if (pendingInFlight === undefined) {
        return prev;
      }
      const next = { ...prev };
      if (next[newThreadId] === undefined) {
        next[newThreadId] = pendingInFlight;
      }
      delete next[oldThreadId];
      return next;
    });

    setHasStartedByThread((prev) => {
      const pendingStarted = prev[oldThreadId];
      if (pendingStarted === undefined) {
        return prev;
      }
      const next = { ...prev };
      if (next[newThreadId] === undefined) {
        next[newThreadId] = pendingStarted;
      }
      delete next[oldThreadId];
      return next;
    });

    setQueuedHandoffByThread((prev) => {
      const pendingHandoff = prev[oldThreadId];
      if (pendingHandoff === undefined) {
        return prev;
      }
      const next = { ...prev };
      if (next[newThreadId] === undefined) {
        next[newThreadId] = pendingHandoff;
      }
      delete next[oldThreadId];
      return next;
    });

    setFusionByThread((prev) => {
      const pendingFusion = prev[oldThreadId];
      if (pendingFusion === undefined) {
        return prev;
      }
      const next = { ...prev };
      if (next[newThreadId] === undefined) {
        next[newThreadId] = pendingFusion;
      }
      delete next[oldThreadId];
      return next;
    });
  }, [activeThreadId, resolveCanonicalThreadId]);

  const buildQueuedMessage = useCallback(
    (
      text: string,
      images: string[] = [],
      options?: MessageSendOptions,
      eagerOptimisticUser = false,
    ): QueuedMessage => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        text,
        createdAt: Date.now(),
        images,
        sendOptions: options,
        ...(eagerOptimisticUser
          ? { eagerOptimisticUserId: buildQueuedOptimisticUserMessageId(id) }
          : {}),
      };
    },
    [],
  );

  const buildCodexHandoffBubble = useCallback(
    (item: QueuedMessage): QueuedHandoffBubble | null => {
      const trimmedText = item.text.trim();
      if (
        activeEngine !== "codex" ||
        parseSlashCommand(trimmedText) ||
        ((item.images?.length ?? 0) === 0 && isImplicitModeQuery(trimmedText))
      ) {
        return null;
      }
      const activeItems = activeItemsRef.current;
      const anchorItemId = activeItems[activeItems.length - 1]?.id;
      return buildQueuedHandoffBubbleItem(item, anchorItemId);
    },
    [activeEngine],
  );

  const ensureQueuedHandoffBubble = useCallback(
    (threadId: string, item: QueuedMessage, replaceCurrent: boolean) => {
      const nextBubble = buildCodexHandoffBubble(item);
      if (!nextBubble) {
        return;
      }
      setQueuedHandoffByThread((previous) => {
        const currentBubble = previous[threadId];
        if (
          !replaceCurrent &&
          currentBubble &&
          !hasCanonicalUserItemForQueuedHandoffBubble(
            activeItemsRef.current,
            currentBubble,
          )
        ) {
          return previous;
        }
        if (currentBubble?.id === nextBubble.id) {
          return previous;
        }
        return { ...previous, [threadId]: nextBubble };
      });
    },
    [buildCodexHandoffBubble],
  );

  const enqueueMessage = useCallback((threadId: string, item: QueuedMessage) => {
    setQueuedByThread((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), item],
    }));
  }, []);

  const removeQueuedMessage = useCallback(
    (threadId: string, messageId: string) => {
      setQueuedByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter(
          (entry) => entry.id !== messageId,
        ),
      }));
      setQueuedHandoffByThread((prev) => {
        const currentBubble = prev[threadId];
        if (currentBubble?.id !== `queued-handoff-${messageId}`) {
          return prev;
        }
        return { ...prev, [threadId]: null };
      });
    },
    [],
  );

  const insertQueuedMessageAt = useCallback(
    (threadId: string, item: QueuedMessage, index: number) => {
      setQueuedByThread((prev) => {
        const threadQueue = [...(prev[threadId] ?? [])];
        const boundedIndex = Math.max(0, Math.min(index, threadQueue.length));
        threadQueue.splice(boundedIndex, 0, item);
        return {
          ...prev,
          [threadId]: threadQueue,
        };
      });
    },
    [],
  );

  const prependQueuedMessage = useCallback(
    (threadId: string, item: QueuedMessage) => {
      insertQueuedMessageAt(threadId, item, 0);
    },
    [insertQueuedMessageAt],
  );

  const withCodexCollaborationMode = useCallback(
    (options?: MessageSendOptions): MessageSendOptions | undefined => {
      if (activeEngine !== "codex") {
        return options;
      }
      const existingPayload = options?.collaborationMode;
      const existingModeRaw =
        existingPayload &&
          typeof existingPayload === "object" &&
          !Array.isArray(existingPayload)
          ? (existingPayload as Record<string, unknown>).mode
          : null;
      const existingMode = typeof existingModeRaw === "string"
        ? existingModeRaw.trim().toLowerCase()
        : null;
      if (existingMode === "plan" || existingMode === "code" || existingMode === "default") {
        return options;
      }
      const currentPayload = getCodexCollaborationPayload?.();
      if (
        currentPayload &&
        typeof currentPayload === "object" &&
        !Array.isArray(currentPayload)
      ) {
        return {
          ...(options ?? {}),
          collaborationMode: { ...currentPayload },
        };
      }
      const currentMode = getCodexCollaborationMode?.();
      if (currentMode !== "plan" && currentMode !== "code") {
        return options;
      }
      return {
        ...(options ?? {}),
        collaborationMode: {
          mode: currentMode,
          settings: {},
        },
      };
    },
    [
      activeEngine,
      getCodexCollaborationMode,
      getCodexCollaborationPayload,
    ],
  );

  const runSlashCommand = useCallback(
    async (
      command: SlashCommandKind,
      trimmed: string,
      options?: MessageSendOptions,
    ): Promise<boolean> => {
      if (
        (command === "plan" || command === "defaultMode" || command === "code") &&
        activeEngine === "codex" &&
        setCodexCollaborationMode
      ) {
        const targetMode = command === "plan" ? "plan" : "code";
        setCodexCollaborationMode(targetMode);
        const rest = trimmed
          .replace(/^\/(?:plan|default|code)\b/i, "")
          .trim();
        if (rest) {
          const modeOverrideOptions: MessageSendOptions = {
            ...(options ?? {}),
            collaborationMode: {
              mode: targetMode,
              settings: {},
            },
          };
          if (options) {
            await sendUserMessage(rest, [], modeOverrideOptions);
          } else {
            await sendUserMessage(rest, [], modeOverrideOptions);
          }
        }
        return true;
      }
      if (command === "mode" && activeEngine === "codex") {
        await startMode(trimmed);
        return true;
      }
      if (command === "fast" && activeEngine === "codex") {
        await startFast(trimmed);
        return true;
      }
      if (command === "fork") {
        await startFork(trimmed, withCodexCollaborationMode(options));
        return true;
      }
      if (command === "review") {
        await startReview(trimmed);
        return true;
      }
      if (command === "resume") {
        await startResume(trimmed);
        return true;
      }
      if (command === "mcp") {
        await startMcp(trimmed);
        return true;
      }
      if (command === "specRoot") {
        await startSpecRoot(trimmed);
        return true;
      }
      if (command === "status") {
        await startStatus(trimmed);
        return true;
      }
      if (command === "context") {
        await startContext(trimmed);
        return true;
      }
      if (command === "export") {
        await startExport(trimmed);
        return true;
      }
      if (command === "import") {
        await startImport(trimmed);
        return true;
      }
      if (command === "lsp") {
        await startLsp(trimmed);
        return true;
      }
      if (command === "share") {
        await startShare(trimmed);
        return true;
      }
      if (command === "compact") {
        await startCompact(trimmed);
        return true;
      }
      if (command === "clear" && activeWorkspace) {
        const threadId = await startThreadForWorkspace(activeWorkspace.id, { engine: activeEngine });
        const rest = trimmed.replace(/^\/(?:clear|reset)\b/i, "").trim();
        const effectiveOptions = withCodexCollaborationMode(options);
        if (threadId && rest) {
          if (effectiveOptions) {
            await sendUserMessageToThread(activeWorkspace, threadId, rest, [], effectiveOptions);
          } else {
            await sendUserMessageToThread(activeWorkspace, threadId, rest, []);
          }
        }
        return true;
      }
      if (command === "new" && activeWorkspace) {
        const threadId = await startThreadForWorkspace(activeWorkspace.id, { engine: activeEngine });
        const rest = trimmed.replace(/^\/new\b/i, "").trim();
        const effectiveOptions = withCodexCollaborationMode(options);
        if (threadId && rest) {
          if (effectiveOptions) {
            await sendUserMessageToThread(activeWorkspace, threadId, rest, [], effectiveOptions);
          } else {
            await sendUserMessageToThread(activeWorkspace, threadId, rest, []);
          }
        }
        return true;
      }
      return false;
    },
    [
      activeWorkspace,
      activeEngine,
      setCodexCollaborationMode,
      sendUserMessage,
      sendUserMessageToThread,
      startFork,
      startReview,
      startResume,
      startMcp,
      startSpecRoot,
      startStatus,
      startContext,
      startExport,
      startImport,
      startLsp,
      startShare,
      startCompact,
      startFast,
      startMode,
      startThreadForWorkspace,
      withCodexCollaborationMode,
    ],
  );

  const dispatchQueuedMessage = useCallback(
    async (
      item: QueuedMessage,
      options?: { targetThreadId?: string | null },
    ): Promise<boolean> => {
      const trimmed = item.text.trim();
      const command = parseSlashCommand(trimmed);
      const commandEnabled = canExecuteSlashCommand(
        command,
        activeEngine,
        activeThreadId,
      );
      if (activeWorkspace && !activeWorkspace.connected) {
        await connectWorkspace(activeWorkspace);
      }
      if (commandEnabled && command) {
        const handled = await runSlashCommand(command, trimmed, item.sendOptions);
        if (handled) {
          return command === "review";
        }
      }
      const implicitModeQuery =
        activeEngine === "codex" &&
        !command &&
        (item.images?.length ?? 0) === 0 &&
        isImplicitModeQuery(trimmed);
      if (implicitModeQuery) {
        await startMode(trimmed);
        return false;
      }
      const selectedOptions = withCodexCollaborationMode(item.sendOptions);
      const effectiveOptions = item.eagerOptimisticUserId
        ? {
            ...(selectedOptions ?? {}),
            eagerOptimisticUserId: item.eagerOptimisticUserId,
            skipOptimisticUserBubble: true,
          }
        : selectedOptions;
      const targetThreadId = options?.targetThreadId?.trim() ?? "";
      const shouldUseDirectThreadSend =
        activeEngine === "codex" &&
        Boolean(activeWorkspace && targetThreadId);
      if (shouldUseDirectThreadSend && activeWorkspace) {
        await sendUserMessageToThread(
          activeWorkspace,
          targetThreadId,
          trimmed,
          item.images ?? [],
          effectiveOptions,
        );
        return true;
      }
      if (effectiveOptions) {
        await sendUserMessage(trimmed, item.images ?? [], effectiveOptions);
      } else {
        await sendUserMessage(trimmed, item.images ?? []);
      }
      return true;
    },
    [
      activeEngine,
      activeThreadId,
      activeWorkspace,
      connectWorkspace,
      runSlashCommand,
      sendUserMessage,
      sendUserMessageToThread,
      startMode,
      withCodexCollaborationMode,
    ],
  );

  const handleSend = useCallback(
    async (
      text: string,
      images: string[] = [],
      options?: MessageSendOptions,
    ) => {
      const trimmed = text.trim();
      const command = parseSlashCommand(trimmed);
      const commandEnabled = canExecuteSlashCommand(
        command,
        activeEngine,
        activeThreadId,
      );
      const nextImages = commandEnabled ? [] : images;
      if (!trimmed && nextImages.length === 0) {
        return;
      }
      if (activeThreadId && isReviewing) {
        return;
      }
      const shouldQueueWhileProcessing =
        isProcessing && (!steerEnabled || isClaudePendingBootstrapThread);
      // A pending AskUserQuestion also holds the queue: the turn is alive but
      // blocked on the answer, so a fresh send must queue rather than dispatch.
        if (activeThreadId && (shouldQueueWhileProcessing || hasPendingUserInput)) {
          const item = buildQueuedMessage(
            trimmed,
            nextImages,
            options,
            activeEngine === "codex" &&
              !options?.suppressUserMessageRender &&
              !options?.skipOptimisticUserBubble,
          );
          enqueueMessage(activeThreadId, item);
          ensureQueuedHandoffBubble(activeThreadId, item, false);
          clearActiveImages();
          return;
      }
      await dispatchQueuedMessage(buildQueuedMessage(trimmed, nextImages, options));
      clearActiveImages();
    },
    [
      activeEngine,
      activeThreadId,
      buildQueuedMessage,
      clearActiveImages,
      dispatchQueuedMessage,
      ensureQueuedHandoffBubble,
      enqueueMessage,
      hasPendingUserInput,
      isClaudePendingBootstrapThread,
      isProcessing,
      isReviewing,
      steerEnabled,
    ],
  );

  const queueMessage = useCallback(
    async (
      text: string,
      images: string[] = [],
      options?: MessageSendOptions,
    ) => {
      const trimmed = text.trim();
      const command = parseSlashCommand(trimmed);
      const commandEnabled = canExecuteSlashCommand(
        command,
        activeEngine,
        activeThreadId,
      );
      const nextImages = commandEnabled ? [] : images;
      if (!trimmed && nextImages.length === 0) {
        return;
      }
      if (activeThreadId && isReviewing) {
        return;
      }
      if (!activeThreadId) {
        return;
      }
      const item = buildQueuedMessage(
        trimmed,
        nextImages,
        options,
        (isProcessing || hasPendingUserInput) &&
          activeEngine === "codex" &&
          !options?.suppressUserMessageRender &&
          !options?.skipOptimisticUserBubble,
      );
      enqueueMessage(activeThreadId, item);
      ensureQueuedHandoffBubble(activeThreadId, item, false);
      clearActiveImages();
    },
    [
      activeEngine,
      activeThreadId,
      buildQueuedMessage,
      clearActiveImages,
      ensureQueuedHandoffBubble,
      enqueueMessage,
      hasPendingUserInput,
      isReviewing,
      isProcessing,
    ],
  );

  const fuseQueuedMessage = useCallback(
    async (threadId: string, messageId: string) => {
      if (!activeThreadId || threadId !== activeThreadId) {
        return;
      }
      if (isClaudePendingBootstrapThread) {
        return;
      }
      if (!activeWorkspace || !isProcessing || isReviewing) {
        return;
      }
      if (fusionByThread[threadId]) {
        return;
      }
      const threadQueue = queuedByThread[threadId] ?? [];
      const originalIndex = threadQueue.findIndex((entry) => entry.id === messageId);
      if (originalIndex < 0) {
        return;
      }
      const item = threadQueue[originalIndex];
      if (!item) {
        return;
      }
      if (!isQueuedMessageFuseEligible(item)) {
        return;
      }

      const useSameRunContinuation = steerEnabled;
      const canUseSafeCutover =
        !useSameRunContinuation && typeof interruptTurn === "function";
      if (!useSameRunContinuation && !canUseSafeCutover) {
        return;
      }

      setFusionByThread((prev) => ({
        ...prev,
        [threadId]: {
          messageId,
          turnIdBeforeFusion: activeTurnId ?? null,
          mode: useSameRunContinuation ? "same-run" : "cutover",
          stage: "dispatching",
          startedAtMs: Date.now(),
          continuationPulseAtStart: activeContinuationPulse,
          terminalPulseAtStart: activeTerminalPulse,
        },
      }));
      setQueuedByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter(
          (entry) => entry.id !== messageId,
        ),
      }));

      try {
        if (!useSameRunContinuation && interruptTurn) {
          await interruptTurn({ reason: "queue-fusion" });
        }
        const fusionItem =
          useSameRunContinuation
            ? item
            : {
                ...item,
                sendOptions: {
                  ...(item.sendOptions ?? {}),
                  resumeSource: "queue-fusion-cutover" as const,
                  resumeTurnId: activeTurnId ?? null,
                },
              };
        const dispatchedRun = await dispatchQueuedMessage(fusionItem, {
          targetThreadId: activeEngine === "codex" ? threadId : null,
        });
        if (!dispatchedRun) {
          setFusionByThread((prev) => ({ ...prev, [threadId]: null }));
          return;
        }
        setFusionByThread((prev) => {
          const current = prev[threadId];
          if (!current || current.messageId !== messageId) {
            return prev;
          }
          return {
            ...prev,
            [threadId]: {
              ...current,
              stage: "awaiting-continuation",
              startedAtMs: Date.now(),
            },
          };
        });
      } catch (error) {
        setFusionByThread((prev) => ({ ...prev, [threadId]: null }));
        insertQueuedMessageAt(threadId, item, originalIndex);
        throw error;
      }
    },
    [
      activeEngine,
      activeThreadId,
      activeContinuationPulse,
      activeTerminalPulse,
      activeTurnId,
      activeWorkspace,
      dispatchQueuedMessage,
      fusionByThread,
      isClaudePendingBootstrapThread,
      insertQueuedMessageAt,
      interruptTurn,
      isProcessing,
      isReviewing,
      queuedByThread,
      steerEnabled,
    ],
  );

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const fusion = fusionByThread[activeThreadId];
    if (!fusion || fusion.stage !== "awaiting-continuation") {
      return;
    }
    const hasTerminalSettlement =
      activeTerminalPulse > fusion.terminalPulseAtStart;
    const hasSameRunContinuation =
      fusion.mode === "same-run"
      && activeContinuationPulse > fusion.continuationPulseAtStart;
    const hasCutoverContinuation =
      fusion.mode === "cutover"
      && activeTurnId !== undefined
      && Boolean(activeTurnId)
      && activeTurnId !== fusion.turnIdBeforeFusion;
    if (
      !hasTerminalSettlement
      && !hasSameRunContinuation
      && !hasCutoverContinuation
    ) {
      return;
    }
    setFusionByThread((prev) => {
      const current = prev[activeThreadId];
      if (!current || current.stage !== "awaiting-continuation") {
        return prev;
      }
      const currentHasTerminalSettlement =
        activeTerminalPulse > current.terminalPulseAtStart;
      const currentHasSameRunContinuation =
        current.mode === "same-run"
        && activeContinuationPulse > current.continuationPulseAtStart;
      const currentHasCutoverContinuation =
        current.mode === "cutover"
        && activeTurnId !== undefined
        && Boolean(activeTurnId)
        && activeTurnId !== current.turnIdBeforeFusion;
      if (
        !currentHasTerminalSettlement
        && !currentHasSameRunContinuation
        && !currentHasCutoverContinuation
      ) {
        return prev;
      }
      return {
        ...prev,
        [activeThreadId]: null,
      };
    });
  }, [
    activeContinuationPulse,
    activeTerminalPulse,
    activeThreadId,
    activeTurnId,
    fusionByThread,
  ]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const handoffBubble = queuedHandoffByThread[activeThreadId];
    if (!handoffBubble) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQueuedHandoffByThread((prev) => {
        const current = prev[activeThreadId];
        if (!current || current.id !== handoffBubble.id) {
          return prev;
        }
        return {
          ...prev,
          [activeThreadId]: null,
        };
      });
    }, QUEUED_HANDOFF_BUBBLE_TTL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThreadId, queuedHandoffByThread]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const inFlight = inFlightByThread[activeThreadId];
    if (!inFlight) {
      return;
    }
    if (isProcessing || isReviewing) {
      if (!hasStartedByThread[activeThreadId]) {
        setHasStartedByThread((prev) => ({
          ...prev,
          [activeThreadId]: true,
        }));
      }
      return;
    }
    if (hasStartedByThread[activeThreadId]) {
      setInFlightByThread((prev) => ({ ...prev, [activeThreadId]: null }));
      setHasStartedByThread((prev) => ({ ...prev, [activeThreadId]: false }));
    }
  }, [
    activeThreadId,
    hasStartedByThread,
    inFlightByThread,
    isProcessing,
    isReviewing,
  ]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const fusion = fusionByThread[activeThreadId];
    if (!fusion || fusion.stage !== "awaiting-continuation") {
      return;
    }
    const timer = window.setTimeout(() => {
      setFusionByThread((prev) => {
        const current = prev[activeThreadId];
        if (!current || current.stage !== "awaiting-continuation") {
          return prev;
        }
        return {
          ...prev,
          [activeThreadId]: null,
        };
      });
      handleFusionStalled?.(activeThreadId);
    }, FUSION_RESUME_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThreadId, fusionByThread, handleFusionStalled]);

  useEffect(() => {
    if (activeEngine !== "opencode") {
      return;
    }
    if (!activeThreadId || isProcessing || isReviewing) {
      return;
    }
    const inFlight = inFlightByThread[activeThreadId];
    if (!inFlight) {
      return;
    }
    if (hasStartedByThread[activeThreadId]) {
      return;
    }
    const timer = window.setTimeout(() => {
      setInFlightByThread((prev) => {
        const current = prev[activeThreadId];
        if (!current || current.id !== inFlight.id) {
          return prev;
        }
        return { ...prev, [activeThreadId]: null };
      });
      setHasStartedByThread((prev) => ({ ...prev, [activeThreadId]: false }));
      prependQueuedMessage(activeThreadId, inFlight);
    }, OPENCODE_INFLIGHT_STALL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeEngine,
    activeThreadId,
    hasStartedByThread,
    inFlightByThread,
    isProcessing,
    isReviewing,
    prependQueuedMessage,
  ]);

  useEffect(() => {
    if (!activeThreadId || isProcessing || isReviewing) {
      return;
    }
    // Hold the queue while an AskUserQuestion dialog is open: the CLI turn is
    // blocked awaiting the answer even though isProcessing may read false, so
    // flushing here would send the queued message as a fresh turn and strand
    // the pending answer (→ 5-min MCP timeout). The queue drains after the
    // dialog is settled and the turn resumes/ends.
    if (hasPendingUserInput) {
      return;
    }
    if (fusionByThread[activeThreadId]) {
      return;
    }
    if (inFlightByThread[activeThreadId]) {
      return;
    }
    const queue = queuedByThread[activeThreadId] ?? [];
    if (queue.length === 0) {
      return;
    }
    const threadId = activeThreadId;
    const nextItem = queue[0];
    if (!nextItem) {
      return;
    }
    ensureQueuedHandoffBubble(threadId, nextItem, true);
    setInFlightByThread((prev) => ({ ...prev, [threadId]: nextItem }));
    setHasStartedByThread((prev) => ({ ...prev, [threadId]: false }));
    setQueuedByThread((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).slice(1),
    }));
    (async () => {
      try {
        const dispatchedRun = await dispatchQueuedMessage(nextItem, {
          targetThreadId: activeEngine === "codex" ? threadId : null,
        });
        if (!dispatchedRun) {
          setInFlightByThread((prev) => ({ ...prev, [threadId]: null }));
          setHasStartedByThread((prev) => ({ ...prev, [threadId]: false }));
          setQueuedHandoffByThread((prev) => ({ ...prev, [threadId]: null }));
        }
      } catch {
        setInFlightByThread((prev) => ({ ...prev, [threadId]: null }));
        setHasStartedByThread((prev) => ({ ...prev, [threadId]: false }));
        setQueuedHandoffByThread((prev) => ({ ...prev, [threadId]: null }));
        prependQueuedMessage(threadId, nextItem);
      }
    })();
  }, [
    activeEngine,
    activeThreadId,
    dispatchQueuedMessage,
    ensureQueuedHandoffBubble,
    fusionByThread,
    hasPendingUserInput,
    inFlightByThread,
    isProcessing,
    isReviewing,
    prependQueuedMessage,
    queuedByThread,
  ]);

  return {
    queuedByThread,
    activeQueue,
    activeQueuedHandoffBubble,
    handleSend,
    queueMessage,
    removeQueuedMessage,
    fuseQueuedMessage,
    canFuseActiveQueue,
    activeFusingMessageId,
  };
}
