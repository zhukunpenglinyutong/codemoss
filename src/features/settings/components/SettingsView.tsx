// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type { DropResult } from "@hello-pangea/dnd";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import Mic from "lucide-react/dist/esm/icons/mic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import Globe from "lucide-react/dist/esm/icons/globe";
import Monitor from "lucide-react/dist/esm/icons/monitor";
import Cog from "lucide-react/dist/esm/icons/cog";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Mail from "lucide-react/dist/esm/icons/mail";
import Archive from "lucide-react/dist/esm/icons/archive";
import NotebookPen from "lucide-react/dist/esm/icons/notebook-pen";
import Boxes from "lucide-react/dist/esm/icons/boxes";
import Bot from "lucide-react/dist/esm/icons/bot";
import type {
  AppSettings,
  CodexDoctorResult,
  DictationModelStatus,
  ThemePresetId,
  ThreadSummary,
  WorkspaceSettings,
  OpenAppTarget,
  WorkspaceGroup,
  WorkspaceInfo,
} from "../../../types";
import { loadSettingsStyles } from "../../../styles/featureStyleLoaders";
import wxqImage from "../../../assets/wxq.png";
import {
  buildShortcutValue,
  getDefaultInterruptShortcut,
} from "../../../utils/shortcuts";
import { clampUiScale } from "../../../utils/uiScale";
import {
  exportDiagnosticsBundle,
  reloadCodexRuntimeConfig,
} from "../../../services/tauri";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  clampCodeFontSize,
  normalizeFontFamily,
} from "../../../utils/fonts";
import { DEFAULT_OPEN_APP_ID } from "../../app/constants";
import { writeClientStoreValue } from "../../../services/clientStorage";
import { VendorSettingsPanel } from "../../vendors/components/VendorSettingsPanel";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { PlaceholderSection } from "./PlaceholderSection";
import { CommitSection } from "./CommitSection";
import { PromptSection } from "./PromptSection";
import { UsageSection } from "./UsageSection";
import { McpSection } from "./McpSection";
import { SkillsSection } from "./SkillsSection";
import { CuratedSection } from "../../curated-skills";
import type { SessionRadarEntry } from "../../session-activity/hooks/useSessionRadarFeed";
import {
  deleteSessionRadarHistoryEntries,
  type SessionRadarHistoryDeleteResult,
} from "../../session-activity/utils/sessionRadarHistoryManagement";
import Settings from "lucide-react/dist/esm/icons/settings";
import GitCommitHorizontal from "lucide-react/dist/esm/icons/git-commit-horizontal";
import BookOpen from "lucide-react/dist/esm/icons/book-open";
import Server from "lucide-react/dist/esm/icons/server";
import Shield from "lucide-react/dist/esm/icons/shield";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/more-horizontal";
import Users from "lucide-react/dist/esm/icons/users";
import {
  normalizeHexColor,
  HEX_COLOR_PATTERN,
  getContrastingTextColor,
} from "../../../utils/colorUtils";
import {
  isHistoryCompletionEnabled,
  setHistoryCompletionEnabled,
} from "../../composer/hooks/useInputHistoryStore";
import {
  buildOpenAppDrafts,
  COMPOSER_PRESET_CONFIGS,
  createOpenAppId,
  type ComposerPreset,
  type OpenAppDraft,
} from "./settings-view/actions/settingsViewActions";
import {
  buildSettingsWithCustomThemePreset,
  getAllThemePresetOptions,
  resolveActiveThemePresetId,
  resolveEffectiveThemeAppearance,
} from "../../theme/utils/themePreset";
import { useSystemResolvedTheme } from "./settings-view/hooks/useSystemResolvedTheme";
import { ProjectsSection } from "./settings-view/sections/ProjectsSection";
import { ComposerSection } from "./settings-view/sections/ComposerSection";
import { ShortcutsSection } from "./settings-view/sections/ShortcutsSection";
import { OpenAppsSection } from "./settings-view/sections/OpenAppsSection";
import { BasicAppearanceSection } from "./settings-view/sections/BasicAppearanceSection";
import { CodexSection } from "./settings-view/sections/CodexSection";
import { OtherSection } from "./settings-view/sections/OtherSection";
import { SessionManagementSection } from "./settings-view/sections/SessionManagementSection";
import {
  RuntimePoolSection,
  type RuntimeSessionEngine,
  type RuntimeSessionEngineCount,
} from "./settings-view/sections/RuntimePoolSection";
import { DetachedExternalChangeToggles } from "./settings-view/sections/DetachedExternalChangeToggles";
import { WebServiceSettings } from "./settings-view/sections/WebServiceSettings";
import { EmailSenderSettings } from "./settings-view/sections/EmailSenderSettings";
import { DictationSection } from "./settings-view/sections/DictationSection";
import { ExperimentalToggleRow } from "./settings-view/components/ExperimentalToggleRow";
import { BasicBehaviorSection } from "./settings-view/sections/BasicBehaviorSection";
import {
  buildShortcutDrafts,
  shortcutDraftKeyBySetting,
  type ShortcutDrafts,
  type ShortcutSettingKey,
} from "./settings-view/settingsViewShortcuts";
import {
  applyUserMessageBubbleCssVars,
  DEFAULT_DARK_USER_MSG,
  DEFAULT_LIGHT_USER_MSG,
  extractPrimaryFontFamily,
  formatFontFamilySetting,
  listLocalUiFonts,
  SettingsViewSection,
  USER_MSG_DARK_PRESETS,
  USER_MSG_LIGHT_PRESETS,
} from "./settings-view/settingsViewAppearance";
import {
  SHOW_COMMIT_ENTRY,
  SHOW_COMPOSER_ENTRY,
  SHOW_DICTATION_ENTRY,
  SHOW_EXPERIMENTAL_ENTRY,
  SHOW_GIT_ENTRY,
  TEMPORARILY_DISABLED_SIDEBAR_SECTIONS as BASE_DISABLED_SIDEBAR_SECTIONS,
} from "./settings-view/settingsViewConstants";
import { useSystemProxySettings } from "./settings-view/hooks/useSystemProxySettings";

export type SettingsViewProps = {
  workspaceGroups: WorkspaceGroup[];
  groupedWorkspaces: Array<{
    id: string | null;
    name: string;
    workspaces: WorkspaceInfo[];
  }>;
  allWorkspaces?: WorkspaceInfo[];
  ungroupedLabel: string;
  onClose: () => void;
  onMoveWorkspace: (id: string, direction: "up" | "down") => void;
  onDeleteWorkspace: (id: string) => void;
  onCreateWorkspaceGroup: (name: string) => Promise<WorkspaceGroup | null>;
  onRenameWorkspaceGroup: (id: string, name: string) => Promise<boolean | null>;
  onMoveWorkspaceGroup: (
    id: string,
    direction: "up" | "down",
  ) => Promise<boolean | null>;
  onDeleteWorkspaceGroup: (id: string) => Promise<boolean | null>;
  onAssignWorkspaceGroup: (
    workspaceId: string,
    groupId: string | null,
  ) => Promise<boolean | null>;
  reduceTransparency: boolean;
  onToggleTransparency: (value: boolean) => void;
  windowTransparencyEnabled?: boolean;
  onToggleWindowTransparency?: (value: boolean) => void;
  windowOpacity?: number;
  onWindowOpacityChange?: (value: number) => void;
  appSettings: AppSettings;
  openAppIconById: Record<string, string>;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onOpenMailSession?: (target: {
    sessionId: string;
    workspaceId: string;
    threadId: string;
    turnId: string;
  }) => void;
  onRunCodexDoctor?: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  onRunClaudeDoctor?: (claudeBin: string | null) => Promise<CodexDoctorResult>;
  onRunDoctor?: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId?: string | null;
  activeEngine: string | null;
  workspaceThreadsById?: Record<string, ThreadSummary[]>;
  onUpdateWorkspaceCodexBin: (
    id: string,
    codexBin: string | null,
  ) => Promise<void>;
  onUpdateWorkspaceSettings: (
    id: string,
    settings: Partial<WorkspaceSettings>,
  ) => Promise<void>;
  sessionRadarRecentCompletedSessions?: SessionRadarEntry[];
  onEnsureWorkspaceThreads?: (
    workspaceId: string,
    options?: { deletedThreadIds?: string[] },
  ) => void;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  onTestNotificationSound: (soundId?: string, customSoundPath?: string) => void;
  dictationModelStatus?: DictationModelStatus | null;
  onDownloadDictationModel?: () => void;
  onCancelDictationDownload?: () => void;
  onRemoveDictationModel?: () => void;
  initialSection?: SettingsViewSection;
  initialHighlightTarget?:
    | "experimental-collaboration-modes"
    | "basic-shortcuts"
    | "basic-open-apps"
    | "basic-web-service"
    | "basic-email"
    | "project-groups"
    | "project-sessions"
    | "project-usage"
    | "agent-management"
    | "prompt-library"
    | "mcp-servers"
    | "mcp-skills"
    | "runtime-pool"
    | "cli-validation";
};
const TEMPORARILY_DISABLED_SIDEBAR_SECTIONS: ReadonlySet<SettingsViewSection> =
  BASE_DISABLED_SIDEBAR_SECTIONS as ReadonlySet<SettingsViewSection>;

function normalizeRuntimeSessionEngine(
  engine: string | null | undefined,
): RuntimeSessionEngine | null {
  switch ((engine ?? "").trim().toLowerCase()) {
    case "claude":
      return "claude";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

function inferRuntimeSessionEngineFromThreadId(
  threadId: string,
): RuntimeSessionEngine {
  if (threadId.startsWith("claude:") || threadId.startsWith("claude-pending-")) {
    return "claude";
  }
  if (threadId.startsWith("gemini:") || threadId.startsWith("gemini-pending-")) {
    return "gemini";
  }
  if (threadId.startsWith("opencode:") || threadId.startsWith("opencode-pending-")) {
    return "opencode";
  }
  return "codex";
}

function resolveRuntimeSessionEngine(thread: ThreadSummary): RuntimeSessionEngine {
  return (
    normalizeRuntimeSessionEngine(thread.engineSource) ??
    normalizeRuntimeSessionEngine(thread.selectedEngine) ??
    inferRuntimeSessionEngineFromThreadId(thread.id)
  );
}

function buildRuntimeSessionEngineCounts(params: {
  workspaceThreadsById?: Record<string, ThreadSummary[]>;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  activeEngine: string | null;
}): RuntimeSessionEngineCount[] {
  const counts: Record<RuntimeSessionEngine, RuntimeSessionEngineCount> = {
    claude: { engine: "claude", count: 0, activeCount: 0 },
    codex: { engine: "codex", count: 0, activeCount: 0 },
    gemini: { engine: "gemini", count: 0, activeCount: 0 },
    opencode: { engine: "opencode", count: 0, activeCount: 0 },
  };
  const knownWorkspaceIds =
    params.workspaces.length > 0
      ? params.workspaces.map((workspace) => workspace.id)
      : Object.keys(params.workspaceThreadsById ?? {});
  const seenThreadKeys = new Set<string>();
  let activeEngine = normalizeRuntimeSessionEngine(params.activeEngine);

  for (const workspaceId of knownWorkspaceIds) {
    const threads = params.workspaceThreadsById?.[workspaceId] ?? [];
    for (const thread of threads) {
      const threadKey = `${workspaceId}:${thread.id}`;
      if (seenThreadKeys.has(threadKey)) {
        continue;
      }
      seenThreadKeys.add(threadKey);
      const engine = resolveRuntimeSessionEngine(thread);
      counts[engine].count += 1;
      if (
        params.activeThreadId === thread.id &&
        (!params.activeWorkspaceId || params.activeWorkspaceId === workspaceId)
      ) {
        activeEngine = engine;
      }
    }
  }

  if (activeEngine) {
    counts[activeEngine].activeCount = 1;
  }

  return [counts.claude, counts.codex, counts.gemini, counts.opencode];
}
export function SettingsView({
  workspaceGroups,
  groupedWorkspaces,
  allWorkspaces,
  ungroupedLabel,
  onClose,
  onMoveWorkspace,
  onDeleteWorkspace,
  onCreateWorkspaceGroup,
  onRenameWorkspaceGroup,
  onMoveWorkspaceGroup: _onMoveWorkspaceGroup,
  onDeleteWorkspaceGroup,
  onAssignWorkspaceGroup,
  reduceTransparency,
  onToggleTransparency,
  windowTransparencyEnabled,
  onToggleWindowTransparency,
  windowOpacity,
  onWindowOpacityChange,
  appSettings,
  openAppIconById,
  onUpdateAppSettings,
  onOpenMailSession,
  onRunCodexDoctor,
  onRunClaudeDoctor,
  onRunDoctor,
  activeWorkspace,
  activeThreadId = null,
  activeEngine,
  workspaceThreadsById,
  onUpdateWorkspaceCodexBin,
  onUpdateWorkspaceSettings,
  sessionRadarRecentCompletedSessions = [],
  onEnsureWorkspaceThreads: _onEnsureWorkspaceThreads,
  scaleShortcutTitle,
  scaleShortcutText,
  onTestNotificationSound,
  dictationModelStatus,
  onDownloadDictationModel,
  onCancelDictationDownload,
  onRemoveDictationModel,
  initialSection,
  initialHighlightTarget,
}: SettingsViewProps) {
  useEffect(() => {
    void loadSettingsStyles();
  }, []);
  const { t } = useTranslation();
  const runCodexDoctor = onRunCodexDoctor ?? onRunDoctor;
  const [activeSection, setActiveSection] =
    useState<SettingsViewSection>("basic");
  const [basicSubTab, setBasicSubTab] = useState<
    | "appearance"
    | "behavior"
    | "shortcuts"
    | "open-apps"
    | "web-service"
    | "email"
  >("appearance");
  const [projectManagementSubTab, setProjectManagementSubTab] = useState<
    "groups" | "sessions" | "usage"
  >("groups");
  const [agentPromptSubTab, setAgentPromptSubTab] = useState<
    "agents" | "prompts"
  >("agents");
  const [mcpManagementSubTab, setMcpManagementSubTab] = useState<
    "servers" | "skills"
  >("servers");
  const [runtimeEnvironmentSubTab, setRuntimeEnvironmentSubTab] = useState<
    "runtime-pool" | "cli-validation"
  >("runtime-pool");
  const [commitPrompt, setCommitPrompt] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [claudePathDraft, setClaudePathDraft] = useState(
    appSettings.claudeBin ?? "",
  );
  const [codexPathDraft, setCodexPathDraft] = useState(
    appSettings.codexBin ?? "",
  );
  const [codexArgsDraft, setCodexArgsDraft] = useState(
    appSettings.codexArgs ?? "",
  );
  const [terminalShellPathDraft, setTerminalShellPathDraft] = useState(
    appSettings.terminalShellPath ?? "",
  );
  const [remoteHostDraft, setRemoteHostDraft] = useState(
    appSettings.remoteBackendHost,
  );
  const [remoteTokenDraft, setRemoteTokenDraft] = useState(
    appSettings.remoteBackendToken ?? "",
  );
  const [uiFontDraft, setUiFontDraft] = useState(
    () =>
      extractPrimaryFontFamily(appSettings.uiFontFamily) ||
      extractPrimaryFontFamily(DEFAULT_UI_FONT_FAMILY),
  );
  const [uiFontOptions, setUiFontOptions] = useState<string[]>([]);
  const [codeFontDraft, setCodeFontDraft] = useState(
    () =>
      extractPrimaryFontFamily(appSettings.codeFontFamily) ||
      extractPrimaryFontFamily(DEFAULT_CODE_FONT_FAMILY),
  );
  const [codeFontSizeDraft, setCodeFontSizeDraft] = useState(
    appSettings.codeFontSize,
  );
  const [uiScaleDraft, setUiScaleDraft] = useState(
    clampUiScale(appSettings.uiScale),
  );
  const [userMsgHexDraft, setUserMsgHexDraft] = useState(() =>
    normalizeHexColor(appSettings.userMsgColor),
  );
  const [notificationSoundPathDraft, setNotificationSoundPathDraft] = useState(
    appSettings.notificationSoundCustomPath ?? "",
  );
  const systemResolvedTheme = useSystemResolvedTheme();
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [highlightedRow, setHighlightedRow] = useState<string | null>(null);
  const [openAppDrafts, setOpenAppDrafts] = useState<OpenAppDraft[]>(() =>
    buildOpenAppDrafts(appSettings.openAppTargets),
  );
  const [openAppSelectedId, setOpenAppSelectedId] = useState(
    appSettings.selectedOpenAppId,
  );
  const [historyCompletionEnabled, setHistoryCompletionEnabledState] = useState(
    () => isHistoryCompletionEnabled(),
  );
  const runtimePanelWorkspaces = useMemo(
    () =>
      allWorkspaces && allWorkspaces.length > 0
        ? allWorkspaces
        : groupedWorkspaces.flatMap((group) => group.workspaces),
    [allWorkspaces, groupedWorkspaces],
  );
  const runtimeSessionEngineCounts = useMemo(
    () =>
      buildRuntimeSessionEngineCounts({
        workspaceThreadsById,
        workspaces: runtimePanelWorkspaces,
        activeWorkspaceId: activeWorkspace?.id ?? null,
        activeThreadId,
        activeEngine,
      }),
    [
      activeEngine,
      activeThreadId,
      activeWorkspace?.id,
      runtimePanelWorkspaces,
      workspaceThreadsById,
    ],
  );
  const handleHistoryCompletionToggle = useCallback(() => {
    const next = !historyCompletionEnabled;
    setHistoryCompletionEnabledState(next);
    setHistoryCompletionEnabled(next);
  }, [historyCompletionEnabled]);
  const [doctorState, setDoctorState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  }>({ status: "idle", result: null });
  const [claudeDoctorState, setClaudeDoctorState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  }>({ status: "idle", result: null });
  const [codexRuntimeReloadState, setCodexRuntimeReloadState] = useState<{
    status: "idle" | "reloading" | "applied" | "failed";
    message: string | null;
  }>({ status: "idle", message: null });
  const [diagnosticsBundleExportState, setDiagnosticsBundleExportState] =
    useState<{
      status: "idle" | "exporting" | "exported" | "failed";
      message: string | null;
    }>({ status: "idle", message: null });
  const diagnosticsBundleRequestIdRef = useRef(0);
  const diagnosticsBundleMountedRef = useRef(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [shortcutDrafts, setShortcutDrafts] = useState<ShortcutDrafts>(() =>
    buildShortcutDrafts(appSettings),
  );
  const {
    handleSaveSystemProxy,
    handleSystemProxyUrlChange,
    handleToggleSystemProxy,
    systemProxyDirty,
    systemProxyEnabledDraft,
    systemProxyError,
    systemProxyNotice,
    systemProxySaving,
    systemProxyUrlDraft,
  } = useSystemProxySettings({
    appSettings,
    onUpdateAppSettings,
    t,
  });
  const normalizedUserMsgColor = useMemo(
    () => normalizeHexColor(appSettings.userMsgColor),
    [appSettings.userMsgColor],
  );
  const resolvedAppearanceTheme = useMemo<"light" | "dark">(
    () =>
      resolveEffectiveThemeAppearance(
        {
          theme: appSettings.theme,
          lightThemePresetId: appSettings.lightThemePresetId,
          darkThemePresetId: appSettings.darkThemePresetId,
          customThemePresetId: appSettings.customThemePresetId,
        },
        systemResolvedTheme,
      ),
    [
      appSettings.customThemePresetId,
      appSettings.darkThemePresetId,
      appSettings.lightThemePresetId,
      appSettings.theme,
      systemResolvedTheme,
    ],
  );
  const activeThemePresetId = useMemo(
    () =>
      resolveActiveThemePresetId(
        {
          theme: appSettings.theme,
          darkThemePresetId: appSettings.darkThemePresetId,
          lightThemePresetId: appSettings.lightThemePresetId,
          customThemePresetId: appSettings.customThemePresetId,
        },
        systemResolvedTheme,
      ),
    [
      appSettings.customThemePresetId,
      appSettings.darkThemePresetId,
      appSettings.lightThemePresetId,
      appSettings.theme,
      systemResolvedTheme,
    ],
  );
  const themePresetOptions = useMemo(
    () =>
      getAllThemePresetOptions().map((preset) => ({
        id: preset.id,
        label: t(preset.labelKey),
      })),
    [t],
  );
  const handleThemePresetChange = useCallback(
    async (presetId: ThemePresetId) => {
      await onUpdateAppSettings(
        buildSettingsWithCustomThemePreset(appSettings, presetId),
      );
    },
    [appSettings, onUpdateAppSettings],
  );
  const userMsgPresets = useMemo(
    () =>
      resolvedAppearanceTheme === "light"
        ? USER_MSG_LIGHT_PRESETS
        : USER_MSG_DARK_PRESETS,
    [resolvedAppearanceTheme],
  );
  const defaultUserMsgColor =
    resolvedAppearanceTheme === "light"
      ? DEFAULT_LIGHT_USER_MSG
      : DEFAULT_DARK_USER_MSG;
  const defaultUiPrimaryFont = useMemo(
    () => extractPrimaryFontFamily(DEFAULT_UI_FONT_FAMILY),
    [],
  );
  const uiFontSelectOptions = useMemo(() => {
    const options = new Set<string>(uiFontOptions);
    const currentPrimary = extractPrimaryFontFamily(appSettings.uiFontFamily);
    if (defaultUiPrimaryFont) {
      options.add(defaultUiPrimaryFont);
    }
    if (currentPrimary) {
      options.add(currentPrimary);
    }
    if (uiFontDraft) {
      options.add(uiFontDraft);
    }
    return Array.from(options).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  }, [
    appSettings.uiFontFamily,
    defaultUiPrimaryFont,
    uiFontDraft,
    uiFontOptions,
  ]);
  const defaultCodePrimaryFont = useMemo(
    () => extractPrimaryFontFamily(DEFAULT_CODE_FONT_FAMILY),
    [],
  );
  const codeFontSelectOptions = useMemo(() => {
    const options = new Set<string>(uiFontOptions);
    const currentPrimary = extractPrimaryFontFamily(appSettings.codeFontFamily);
    if (defaultCodePrimaryFont) {
      options.add(defaultCodePrimaryFont);
    }
    if (currentPrimary) {
      options.add(currentPrimary);
    }
    if (codeFontDraft) {
      options.add(codeFontDraft);
    }
    return Array.from(options).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  }, [
    appSettings.codeFontFamily,
    codeFontDraft,
    defaultCodePrimaryFont,
    uiFontOptions,
  ]);
  const selectedNotificationSound = useMemo(() => {
    const raw = appSettings.notificationSoundId?.trim();
    if (!raw) {
      return "default";
    }
    if (
      raw === "default" ||
      raw === "chime" ||
      raw === "bell" ||
      raw === "ding" ||
      raw === "success" ||
      raw === "custom"
    ) {
      return raw;
    }
    return "default";
  }, [appSettings.notificationSoundId]);
  const soundOptions = useMemo(
    () => [
      { value: "default", label: t("settings.soundOptionDefault") },
      { value: "chime", label: t("settings.soundOptionChime") },
      { value: "bell", label: t("settings.soundOptionBell") },
      { value: "ding", label: t("settings.soundOptionDing") },
      { value: "success", label: t("settings.soundOptionSuccess") },
      { value: "custom", label: t("settings.soundOptionCustom") },
    ],
    [t],
  );
  const clampedUiScale = clampUiScale(appSettings.uiScale);
  const uiScaleDraftPercentLabel = `${Math.round(uiScaleDraft * 100)}%`;
  const projects = useMemo(
    () => groupedWorkspaces.flatMap((group) => group.workspaces),
    [groupedWorkspaces],
  );
  const sessionWorkspaceOptions = useMemo(
    () =>
      allWorkspaces && allWorkspaces.length > 0 ? allWorkspaces : projects,
    [allWorkspaces, projects],
  );
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(
    null,
  );
  const selectedSettingsWorkspace = useMemo(() => {
    if (sessionWorkspaceOptions.length === 0) {
      return activeWorkspace;
    }
    if (settingsWorkspaceId) {
      const matched = sessionWorkspaceOptions.find(
        (workspace) => workspace.id === settingsWorkspaceId,
      );
      if (matched) {
        return matched;
      }
    }
    if (
      activeWorkspace &&
      sessionWorkspaceOptions.some(
        (workspace) => workspace.id === activeWorkspace.id,
      )
    ) {
      return activeWorkspace;
    }
    return sessionWorkspaceOptions[0] ?? null;
  }, [activeWorkspace, sessionWorkspaceOptions, settingsWorkspaceId]);
  const mcpContextWorkspace = useMemo(
    () => activeWorkspace ?? projects[0] ?? null,
    [activeWorkspace, projects],
  );
  const handleDeleteSessionRadarHistoryInSettings = useCallback(
    async (entries: SessionRadarEntry[]) => {
      const targets = entries.map((entry) => ({
        id: entry.id,
        completedAt: entry.completedAt ?? entry.updatedAt,
      }));
      return Promise.resolve(deleteSessionRadarHistoryEntries(targets));
    },
    [],
  );
  const shouldShowWorkspaceSelector = false;
  const mcpSectionDisabled = TEMPORARILY_DISABLED_SIDEBAR_SECTIONS.has("mcp");
  const permissionsSectionDisabled =
    TEMPORARILY_DISABLED_SIDEBAR_SECTIONS.has("permissions");
  const hasCodexHomeOverrides = useMemo(
    () => projects.some((workspace) => workspace.settings.codexHome != null),
    [projects],
  );
  useEffect(() => {
    let active = true;
    void getVersion()
      .then((v) => {
        if (active) setAppVersion(v);
      })
      .catch(() => {
        if (active) setAppVersion(null);
      });
    return () => {
      active = false;
    };
  }, [t]);
  useEffect(() => {
    let active = true;
    void listLocalUiFonts()
      .then((fonts) => {
        if (active) {
          setUiFontOptions(fonts);
        }
      })
      .catch(() => {
        if (active) {
          setUiFontOptions([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    diagnosticsBundleMountedRef.current = true;
    return () => {
      diagnosticsBundleMountedRef.current = false;
      diagnosticsBundleRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setClaudePathDraft(appSettings.claudeBin ?? "");
  }, [appSettings.claudeBin]);

  useEffect(() => {
    setCodexPathDraft(appSettings.codexBin ?? "");
  }, [appSettings.codexBin]);

  useEffect(() => {
    setCodexArgsDraft(appSettings.codexArgs ?? "");
  }, [appSettings.codexArgs]);

  useEffect(() => {
    setTerminalShellPathDraft(appSettings.terminalShellPath ?? "");
  }, [appSettings.terminalShellPath]);

  useEffect(() => {
    setRemoteHostDraft(appSettings.remoteBackendHost);
  }, [appSettings.remoteBackendHost]);

  useEffect(() => {
    setRemoteTokenDraft(appSettings.remoteBackendToken ?? "");
  }, [appSettings.remoteBackendToken]);

  useEffect(() => {
    const nextPrimaryFont =
      extractPrimaryFontFamily(appSettings.uiFontFamily) ||
      extractPrimaryFontFamily(DEFAULT_UI_FONT_FAMILY);
    setUiFontDraft(nextPrimaryFont);
  }, [appSettings.uiFontFamily]);

  useEffect(() => {
    const nextPrimaryFont =
      extractPrimaryFontFamily(appSettings.codeFontFamily) ||
      extractPrimaryFontFamily(DEFAULT_CODE_FONT_FAMILY);
    setCodeFontDraft(nextPrimaryFont);
  }, [appSettings.codeFontFamily]);

  useEffect(() => {
    setCodeFontSizeDraft(appSettings.codeFontSize);
  }, [appSettings.codeFontSize]);

  useEffect(() => {
    setUiScaleDraft(clampedUiScale);
  }, [clampedUiScale]);

  useEffect(() => {
    setUserMsgHexDraft(normalizedUserMsgColor);
  }, [normalizedUserMsgColor]);

  useEffect(() => {
    setNotificationSoundPathDraft(
      appSettings.notificationSoundCustomPath ?? "",
    );
  }, [appSettings.notificationSoundCustomPath]);

  useEffect(() => {
    setOpenAppDrafts(buildOpenAppDrafts(appSettings.openAppTargets));
    setOpenAppSelectedId(appSettings.selectedOpenAppId);
  }, [appSettings.openAppTargets, appSettings.selectedOpenAppId]);

  useEffect(() => {
    setShortcutDrafts(buildShortcutDrafts(appSettings));
  }, [appSettings]);

  useEffect(() => {
    if (sessionWorkspaceOptions.length === 0) {
      setSettingsWorkspaceId(null);
      return;
    }
    setSettingsWorkspaceId((current) => {
      if (
        current &&
        sessionWorkspaceOptions.some((workspace) => workspace.id === current)
      ) {
        return current;
      }
      if (
        activeWorkspace &&
        sessionWorkspaceOptions.some(
          (workspace) => workspace.id === activeWorkspace.id,
        )
      ) {
        return activeWorkspace.id;
      }
      return sessionWorkspaceOptions[0]?.id ?? null;
    });
  }, [activeWorkspace, sessionWorkspaceOptions]);

  useEffect(() => {
    setGroupDrafts((prev) => {
      const next: Record<string, string> = {};
      workspaceGroups.forEach((group) => {
        next[group.id] = prev[group.id] ?? group.name;
      });
      return next;
    });
  }, [workspaceGroups]);

  useEffect(() => {
    if (initialSection) {
      setActiveSection(
        TEMPORARILY_DISABLED_SIDEBAR_SECTIONS.has(initialSection)
          ? "basic"
          : initialSection,
      );
    }
  }, [initialSection]);

  useEffect(() => {
    switch (initialHighlightTarget) {
      case "basic-shortcuts":
        setActiveSection("basic");
        setBasicSubTab("shortcuts");
        return;
      case "basic-open-apps":
        setActiveSection("basic");
        setBasicSubTab("open-apps");
        return;
      case "basic-web-service":
        setActiveSection("basic");
        setBasicSubTab("web-service");
        return;
      case "basic-email":
        setActiveSection("basic");
        setBasicSubTab("email");
        return;
      case "project-groups":
        setActiveSection("project-management");
        setProjectManagementSubTab("groups");
        return;
      case "project-sessions":
        setActiveSection("project-management");
        setProjectManagementSubTab("sessions");
        return;
      case "project-usage":
        setActiveSection("project-management");
        setProjectManagementSubTab("usage");
        return;
      case "agent-management":
        setActiveSection("agent-prompt-management");
        setAgentPromptSubTab("agents");
        return;
      case "prompt-library":
        setActiveSection("agent-prompt-management");
        setAgentPromptSubTab("prompts");
        return;
      case "mcp-servers":
        setActiveSection("mcp");
        setMcpManagementSubTab("servers");
        return;
      case "mcp-skills":
        setActiveSection("mcp");
        setMcpManagementSubTab("skills");
        return;
      case "runtime-pool":
        setActiveSection("runtime-environment");
        setRuntimeEnvironmentSubTab("runtime-pool");
        return;
      case "cli-validation":
        setActiveSection("runtime-environment");
        setRuntimeEnvironmentSubTab("cli-validation");
        return;
      default:
        return;
    }
  }, [initialHighlightTarget]);

  useEffect(() => {
    if (
      !(
        (initialSection === "agent-prompt-management" &&
          initialHighlightTarget === "prompt-library") ||
        (initialSection === "project-management" &&
          initialHighlightTarget === "project-sessions")
      )
    ) {
      return;
    }
    setSettingsWorkspaceId(activeWorkspace?.id ?? null);
  }, [activeWorkspace?.id, initialHighlightTarget, initialSection]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "w") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (activeSection !== "experimental") {
      return;
    }
    if (initialHighlightTarget !== "experimental-collaboration-modes") {
      return;
    }
    setHighlightedRow("experimental-collaboration-modes");
    const timer = window.setTimeout(() => {
      setHighlightedRow((current) =>
        current === "experimental-collaboration-modes" ? null : current,
      );
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [activeSection, initialHighlightTarget]);

  const nextClaudeBin = claudePathDraft.trim() ? claudePathDraft.trim() : null;
  const nextCodexBin = codexPathDraft.trim() ? codexPathDraft.trim() : null;
  const nextCodexArgs = codexArgsDraft.trim() ? codexArgsDraft.trim() : null;
  const nextTerminalShellPath = terminalShellPathDraft.trim()
    ? terminalShellPathDraft.trim()
    : null;
  const claudeDirty = nextClaudeBin !== (appSettings.claudeBin ?? null);
  const codexDirty =
    nextCodexBin !== (appSettings.codexBin ?? null) ||
    nextCodexArgs !== (appSettings.codexArgs ?? null);
  const terminalShellPathDirty =
    nextTerminalShellPath !== (appSettings.terminalShellPath ?? null);

  const handleSaveClaudeSettings = async () => {
    setIsSavingSettings(true);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        claudeBin: nextClaudeBin,
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSaveCodexSettings = async () => {
    setIsSavingSettings(true);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexBin: nextCodexBin,
        codexArgs: nextCodexArgs,
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSaveTerminalShellPath = async () => {
    await onUpdateAppSettings({
      ...appSettings,
      terminalShellPath: nextTerminalShellPath,
    });
  };

  const handleClearTerminalShellPath = async () => {
    setTerminalShellPathDraft("");
    if (appSettings.terminalShellPath == null) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      terminalShellPath: null,
    });
  };

  const handleCommitRemoteHost = async () => {
    const nextHost = remoteHostDraft.trim() || "127.0.0.1:4732";
    setRemoteHostDraft(nextHost);
    if (nextHost === appSettings.remoteBackendHost) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendHost: nextHost,
    });
  };

  const handleCommitRemoteToken = async () => {
    const nextToken = remoteTokenDraft.trim() ? remoteTokenDraft.trim() : null;
    setRemoteTokenDraft(nextToken ?? "");
    if (nextToken === appSettings.remoteBackendToken) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendToken: nextToken,
    });
  };

  const handleSaveUiScale = useCallback(() => {
    const nextScale = clampUiScale(uiScaleDraft);
    if (nextScale === clampedUiScale) {
      return;
    }
    void onUpdateAppSettings({
      ...appSettings,
      uiScale: nextScale,
    });
  }, [appSettings, clampedUiScale, onUpdateAppSettings, uiScaleDraft]);

  const handleResetUiScaleDraft = useCallback(() => {
    setUiScaleDraft(1);
  }, []);

  const handleCommitUiFont = useCallback(
    async (selectedFontName: string) => {
      const normalizedFontName = selectedFontName.trim();
      const nextFont = normalizeFontFamily(
        formatFontFamilySetting(normalizedFontName),
        DEFAULT_UI_FONT_FAMILY,
      );
      if (nextFont === appSettings.uiFontFamily) {
        return;
      }
      await onUpdateAppSettings({
        ...appSettings,
        uiFontFamily: nextFont,
      });
    },
    [appSettings, onUpdateAppSettings],
  );

  const handleUiFontSelectChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const nextFontName = event.target.value;
      setUiFontDraft(nextFontName);
      void handleCommitUiFont(nextFontName);
    },
    [handleCommitUiFont],
  );

  const handleCommitCodeFont = useCallback(
    async (selectedFontName: string) => {
      const normalizedFontName = selectedFontName.trim();
      const nextFont = normalizeFontFamily(
        formatFontFamilySetting(normalizedFontName),
        DEFAULT_CODE_FONT_FAMILY,
      );
      if (nextFont === appSettings.codeFontFamily) {
        return;
      }
      await onUpdateAppSettings({
        ...appSettings,
        codeFontFamily: nextFont,
      });
    },
    [appSettings, onUpdateAppSettings],
  );

  const handleCodeFontSelectChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const nextFontName = event.target.value;
      setCodeFontDraft(nextFontName);
      void handleCommitCodeFont(nextFontName);
    },
    [handleCommitCodeFont],
  );

  const handleCommitCodeFontSize = async (nextSize: number) => {
    const clampedSize = clampCodeFontSize(nextSize);
    setCodeFontSizeDraft(clampedSize);
    if (clampedSize === appSettings.codeFontSize) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      codeFontSize: clampedSize,
    });
  };

  const handleSaveUserMsgColor = useCallback(
    async (nextColor: string) => {
      const normalized = normalizeHexColor(nextColor);
      applyUserMessageBubbleCssVars(
        normalized || null,
        normalized ? getContrastingTextColor(normalized) : null,
      );
      if (normalized === normalizedUserMsgColor) {
        return;
      }
      await onUpdateAppSettings({
        ...appSettings,
        userMsgColor: normalized,
      });
    },
    [appSettings, normalizedUserMsgColor, onUpdateAppSettings],
  );

  const handleUserMsgPresetClick = useCallback(
    (presetColor: string) => {
      const normalizedPreset = presetColor.toLowerCase();
      const nextColor =
        normalizedPreset === defaultUserMsgColor ? "" : normalizedPreset;
      setUserMsgHexDraft(nextColor);
      void handleSaveUserMsgColor(nextColor);
    },
    [defaultUserMsgColor, handleSaveUserMsgColor],
  );

  const handleUserMsgColorPickerChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextColor = normalizeHexColor(event.target.value);
      setUserMsgHexDraft(nextColor);
      void handleSaveUserMsgColor(nextColor);
    },
    [handleSaveUserMsgColor],
  );

  const handleUserMsgHexInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      setUserMsgHexDraft(nextValue);
      if (HEX_COLOR_PATTERN.test(nextValue)) {
        void handleSaveUserMsgColor(nextValue);
      }
    },
    [handleSaveUserMsgColor],
  );

  const handleResetUserMsgColor = useCallback(() => {
    setUserMsgHexDraft("");
    void handleSaveUserMsgColor("");
  }, [handleSaveUserMsgColor]);

  const handleNotificationSoundOptionChange = useCallback(
    (nextSound: string | null) => {
      if (!nextSound) {
        return;
      }
      if (nextSound === selectedNotificationSound) {
        return;
      }
      void onUpdateAppSettings({
        ...appSettings,
        notificationSoundId: nextSound,
      });
    },
    [appSettings, onUpdateAppSettings, selectedNotificationSound],
  );

  const handleSaveNotificationSoundPath = useCallback(() => {
    const nextPath = notificationSoundPathDraft.trim();
    if (nextPath === (appSettings.notificationSoundCustomPath ?? "")) {
      return;
    }
    void onUpdateAppSettings({
      ...appSettings,
      notificationSoundCustomPath: nextPath,
    });
  }, [appSettings, notificationSoundPathDraft, onUpdateAppSettings]);

  const handleBrowseNotificationSoundPath = useCallback(async () => {
    const selection = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "aiff"],
        },
      ],
    });
    if (typeof selection !== "string" || !selection.trim()) {
      return;
    }
    const nextPath = selection.trim();
    setNotificationSoundPathDraft(nextPath);
    await onUpdateAppSettings({
      ...appSettings,
      notificationSoundId: "custom",
      notificationSoundCustomPath: nextPath,
    });
  }, [appSettings, onUpdateAppSettings]);

  const isUserMsgPresetActive = useCallback(
    (presetColor: string) => {
      const normalizedPreset = presetColor.toLowerCase();
      if (!normalizedUserMsgColor && normalizedPreset === defaultUserMsgColor) {
        return true;
      }
      return normalizedUserMsgColor === normalizedPreset;
    },
    [defaultUserMsgColor, normalizedUserMsgColor],
  );

  const normalizeOpenAppTargets = useCallback(
    (drafts: OpenAppDraft[]): OpenAppTarget[] =>
      drafts.map(({ argsText, ...target }) => ({
        ...target,
        label: target.label.trim(),
        appName: (target.appName?.trim() ?? "") || null,
        command: (target.command?.trim() ?? "") || null,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      })),
    [],
  );

  const handleCommitOpenApps = useCallback(
    async (drafts: OpenAppDraft[], selectedId = openAppSelectedId) => {
      const nextTargets = normalizeOpenAppTargets(drafts);
      const nextSelectedId =
        nextTargets.find((target) => target.id === selectedId)?.id ??
        nextTargets[0]?.id ??
        DEFAULT_OPEN_APP_ID;
      setOpenAppDrafts(buildOpenAppDrafts(nextTargets));
      setOpenAppSelectedId(nextSelectedId);
      await onUpdateAppSettings({
        ...appSettings,
        openAppTargets: nextTargets,
        selectedOpenAppId: nextSelectedId,
      });
    },
    [
      appSettings,
      normalizeOpenAppTargets,
      onUpdateAppSettings,
      openAppSelectedId,
    ],
  );

  const handleOpenAppDraftChange = (
    index: number,
    updates: Partial<OpenAppDraft>,
  ) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = { ...current, ...updates };
      return next;
    });
  };

  const handleOpenAppKindChange = (
    index: number,
    kind: OpenAppTarget["kind"],
  ) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = {
        ...current,
        kind,
        appName: kind === "app" ? (current.appName ?? "") : null,
        command: kind === "command" ? (current.command ?? "") : null,
        argsText: kind === "finder" ? "" : current.argsText,
      };
      void handleCommitOpenApps(next);
      return next;
    });
  };

  const handleMoveOpenApp = (index: number, direction: "up" | "down") => {
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= openAppDrafts.length) {
      return;
    }
    const next = [...openAppDrafts];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next);
  };

  const handleDeleteOpenApp = (index: number) => {
    if (openAppDrafts.length <= 1) {
      return;
    }
    const removed = openAppDrafts[index];
    const next = openAppDrafts.filter((_, draftIndex) => draftIndex !== index);
    const nextSelected =
      removed?.id === openAppSelectedId
        ? (next[0]?.id ?? DEFAULT_OPEN_APP_ID)
        : openAppSelectedId;
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, nextSelected);
  };

  const handleAddOpenApp = () => {
    const newTarget: OpenAppDraft = {
      id: createOpenAppId(),
      label: t("settings.newApp"),
      kind: "app",
      appName: "",
      command: null,
      args: [],
      argsText: "",
    };
    const next = [...openAppDrafts, newTarget];
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, newTarget.id);
  };

  const handleSelectOpenAppDefault = (id: string) => {
    setOpenAppSelectedId(id);
    writeClientStoreValue("app", "openWorkspaceApp", id);
    void handleCommitOpenApps(openAppDrafts, id);
  };

  const handleComposerPresetChange = (preset: ComposerPreset) => {
    const config = COMPOSER_PRESET_CONFIGS[preset];
    void onUpdateAppSettings({
      ...appSettings,
      composerEditorPreset: preset,
      ...config,
    });
  };

  const handleComposerSendShortcutChange = (
    shortcut: AppSettings["composerSendShortcut"],
  ) => {
    if (appSettings.composerSendShortcut === shortcut) {
      return;
    }
    void onUpdateAppSettings({
      ...appSettings,
      composerSendShortcut: shortcut,
    });
  };

  const handleBrowseCodex = async () => {
    const selection = await open({ multiple: false, directory: false });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setCodexPathDraft(selection);
  };

  const handleBrowseClaude = async () => {
    const selection = await open({ multiple: false, directory: false });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setClaudePathDraft(selection);
  };

  const handleRunDoctor = async () => {
    setDoctorState({ status: "running", result: null });
    try {
      if (!runCodexDoctor) {
        throw new Error("Codex doctor is not available.");
      }
      const result = await runCodexDoctor(nextCodexBin, nextCodexArgs);
      setDoctorState({ status: "done", result });
    } catch (error) {
      setDoctorState({
        status: "done",
        result: {
          ok: false,
          codexBin: nextCodexBin,
          version: null,
          appServerOk: false,
          details: error instanceof Error ? error.message : String(error),
          path: null,
          nodeOk: false,
          nodeVersion: null,
          nodeDetails: null,
        },
      });
    }
  };

  const handleRunClaudeDoctor = async () => {
    setClaudeDoctorState({ status: "running", result: null });
    try {
      if (!onRunClaudeDoctor) {
        throw new Error("Claude doctor is not available.");
      }
      const result = await onRunClaudeDoctor(nextClaudeBin);
      setClaudeDoctorState({ status: "done", result });
    } catch (error) {
      setClaudeDoctorState({
        status: "done",
        result: {
          ok: false,
          codexBin: nextClaudeBin,
          version: null,
          appServerOk: false,
          details: error instanceof Error ? error.message : String(error),
          path: null,
          nodeOk: false,
          nodeVersion: null,
          nodeDetails: null,
        },
      });
    }
  };

  const handleReloadCodexRuntimeConfig = useCallback(async () => {
    setCodexRuntimeReloadState({ status: "reloading", message: null });
    try {
      const result = await reloadCodexRuntimeConfig();
      const message =
        result.restartedSessions === 0
          ? t("settings.codexRuntimeReloadNoConnectedSessions")
          : t("settings.codexRuntimeReloadAppliedCount", {
              count: result.restartedSessions,
            });
      setCodexRuntimeReloadState({ status: "applied", message });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCodexRuntimeReloadState({
        status: "failed",
        message,
      });
    }
  }, [t]);

  const handleExportDiagnosticsBundle = useCallback(async () => {
    const requestId = diagnosticsBundleRequestIdRef.current + 1;
    diagnosticsBundleRequestIdRef.current = requestId;
    setDiagnosticsBundleExportState({ status: "exporting", message: null });
    try {
      const result = await exportDiagnosticsBundle();
      if (
        !diagnosticsBundleMountedRef.current ||
        diagnosticsBundleRequestIdRef.current !== requestId
      ) {
        return;
      }
      setDiagnosticsBundleExportState({
        status: "exported",
        message: t("settings.diagnosticsBundleExported", {
          path: result.filePath,
        }),
      });
    } catch (error) {
      if (
        !diagnosticsBundleMountedRef.current ||
        diagnosticsBundleRequestIdRef.current !== requestId
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setDiagnosticsBundleExportState({
        status: "failed",
        message: t("settings.diagnosticsBundleExportFailed", {
          error: message,
        }),
      });
    }
  }, [t]);

  const updateShortcut = async (
    key: ShortcutSettingKey,
    value: string | null,
  ) => {
    const draftKey = shortcutDraftKeyBySetting[key];
    setShortcutDrafts((prev) => ({
      ...prev,
      [draftKey]: value ?? "",
    }));
    await onUpdateAppSettings({
      ...appSettings,
      [key]: value,
    });
  };

  const handleShortcutKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    key: ShortcutSettingKey,
  ) => {
    if (event.key === "Tab" && key !== "composerCollaborationShortcut") {
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      void updateShortcut(key, null);
      return;
    }
    const value = buildShortcutValue(event.nativeEvent);
    if (!value) {
      return;
    }
    // Blur after a successful capture so the recorded value shows immediately
    // (the input renders blank while focused to surface the "press shortcut" prompt).
    const input = event.currentTarget;
    void updateShortcut(key, value);
    input.blur();
  };

  const trimmedGroupName = newGroupName.trim();
  const canCreateGroup = Boolean(trimmedGroupName);

  const handleCreateGroup = async () => {
    setGroupError(null);
    try {
      const created = await onCreateWorkspaceGroup(newGroupName);
      if (created) {
        setNewGroupName("");
        setCreateGroupOpen(false);
      }
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRenameGroup = async (group: WorkspaceGroup) => {
    const draft = groupDrafts[group.id] ?? "";
    const trimmed = draft.trim();
    if (!trimmed || trimmed === group.name) {
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
      return;
    }
    setGroupError(null);
    try {
      await onRenameWorkspaceGroup(group.id, trimmed);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
    }
  };

  const updateGroupCopiesFolder = async (
    groupId: string,
    copiesFolder: string | null,
  ) => {
    setGroupError(null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        workspaceGroups: appSettings.workspaceGroups.map((entry) =>
          entry.id === groupId ? { ...entry, copiesFolder } : entry,
        ),
      });
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleChooseGroupCopiesFolder = async (group: WorkspaceGroup) => {
    const selection = await open({ multiple: false, directory: true });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    await updateGroupCopiesFolder(group.id, selection);
  };

  const handleClearGroupCopiesFolder = async (group: WorkspaceGroup) => {
    if (!group.copiesFolder) {
      return;
    }
    await updateGroupCopiesFolder(group.id, null);
  };

  const handleDeleteGroup = async (group: WorkspaceGroup) => {
    const groupProjects =
      groupedWorkspaces.find((entry) => entry.id === group.id)?.workspaces ??
      [];
    const detail =
      groupProjects.length > 0
        ? `\n\n${t("settings.deleteGroupWarning")} "${ungroupedLabel}".`
        : "";
    const confirmed = await ask(
      `${t("common.delete")} "${group.name}"?${detail}`,
      {
        title: t("settings.deleteGroupTitle"),
        kind: "warning",
        okLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!confirmed) {
      return;
    }
    setGroupError(null);
    try {
      await onDeleteWorkspaceGroup(group.id);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) {
      return;
    }
    const sourceIndex = result.source.index;
    const destinationIndex = result.destination.index;
    if (sourceIndex === destinationIndex) {
      return;
    }

    const newGroups = Array.from(workspaceGroups);
    const [moved] = newGroups.splice(sourceIndex, 1);
    newGroups.splice(destinationIndex, 0, moved);

    // Update sortOrder based on the new index to persist the order
    const updatedGroups = newGroups.map((group, index) => ({
      ...group,
      sortOrder: index,
    }));

    void onUpdateAppSettings({
      ...appSettings,
      workspaceGroups: updatedGroups,
    });
  };

  return (
    <div className="settings-embedded">
      <div className="settings-header" />
      <div
        className={`settings-body${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
      >
        <aside
          className={`settings-sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
        >
          <button
            type="button"
            className="settings-nav settings-nav-return"
            onClick={onClose}
            aria-label={t("settings.backToApp")}
            title={sidebarCollapsed ? t("settings.backToApp") : ""}
          >
            <ArrowLeft aria-hidden />
            {!sidebarCollapsed && t("settings.backToApp")}
          </button>
          <button
            type="button"
            className={`settings-nav ${activeSection === "basic" ? "active" : ""}`}
            onClick={() => setActiveSection("basic")}
            title={sidebarCollapsed ? t("settings.sidebarBasic") : ""}
          >
            <Settings aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarBasic")}
          </button>
          <button
            type="button"
            className={`settings-nav ${activeSection === "providers" || activeSection === "vendors" ? "active" : ""}`}
            onClick={() => setActiveSection("providers")}
            title={sidebarCollapsed ? t("settings.sidebarProviders") : ""}
          >
            <span className="codicon codicon-vm-connect" />
            {!sidebarCollapsed && t("settings.sidebarProviders")}
          </button>
          <button
            type="button"
            className={`settings-nav ${activeSection === "project-management" ? "active" : ""}`}
            onClick={() => setActiveSection("project-management")}
            title={
              sidebarCollapsed ? t("settings.sidebarProjectManagement") : ""
            }
          >
            <LayoutGrid aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarProjectManagement")}
          </button>
          <button
            type="button"
            className={`settings-nav ${!mcpSectionDisabled && activeSection === "mcp" ? "active" : ""}${mcpSectionDisabled ? " is-disabled" : ""}`}
            onClick={() => {
              if (!mcpSectionDisabled) {
                setActiveSection("mcp");
              }
            }}
            disabled={mcpSectionDisabled}
            title={sidebarCollapsed ? t("settings.sidebarMcpSkills") : ""}
          >
            <Server aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarMcpSkills")}
          </button>
          <button
            type="button"
            className={`settings-nav ${!permissionsSectionDisabled && activeSection === "permissions" ? "active" : ""}${permissionsSectionDisabled ? " is-disabled" : ""}`}
            onClick={() => {
              if (!permissionsSectionDisabled) {
                setActiveSection("permissions");
              }
            }}
            disabled={permissionsSectionDisabled}
            title={sidebarCollapsed ? t("settings.sidebarPermissions") : ""}
          >
            <Shield aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarPermissions")}
          </button>
          {SHOW_COMMIT_ENTRY && (
            <button
              type="button"
              className={`settings-nav ${activeSection === "commit" ? "active" : ""}`}
              onClick={() => setActiveSection("commit")}
              title={sidebarCollapsed ? t("settings.sidebarCommit") : ""}
            >
              <GitCommitHorizontal aria-hidden />
              {!sidebarCollapsed && t("settings.sidebarCommit")}
            </button>
          )}
          <button
            type="button"
            className={`settings-nav ${activeSection === "agent-prompt-management" ? "active" : ""}`}
            onClick={() => setActiveSection("agent-prompt-management")}
            title={
              sidebarCollapsed ? t("settings.sidebarAgentPromptManagement") : ""
            }
          >
            <span className="codicon codicon-robot" />
            {!sidebarCollapsed && t("settings.sidebarAgentPromptManagement")}
          </button>
          {SHOW_COMPOSER_ENTRY && (
            <button
              type="button"
              className={`settings-nav ${activeSection === "composer" ? "active" : ""}`}
              onClick={() => setActiveSection("composer")}
              title={sidebarCollapsed ? t("settings.sidebarComposer") : ""}
            >
              <FileText aria-hidden />
              {!sidebarCollapsed && t("settings.sidebarComposer")}
            </button>
          )}
          {SHOW_DICTATION_ENTRY && (
            <button
              type="button"
              className={`settings-nav ${activeSection === "dictation" ? "active" : ""}`}
              onClick={() => setActiveSection("dictation")}
              title={sidebarCollapsed ? t("settings.sidebarDictation") : ""}
            >
              <Mic aria-hidden />
              {!sidebarCollapsed && t("settings.sidebarDictation")}
            </button>
          )}
          {SHOW_GIT_ENTRY && (
            <button
              type="button"
              className={`settings-nav ${activeSection === "git" ? "active" : ""}`}
              onClick={() => setActiveSection("git")}
              title={sidebarCollapsed ? t("settings.sidebarGit") : ""}
            >
              <GitBranch aria-hidden />
              {!sidebarCollapsed && t("settings.sidebarGit")}
            </button>
          )}
          <button
            type="button"
            className={`settings-nav ${activeSection === "runtime-environment" ? "active" : ""}`}
            onClick={() => setActiveSection("runtime-environment")}
            title={
              sidebarCollapsed ? t("settings.sidebarRuntimeEnvironment") : ""
            }
          >
            <TerminalSquare aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarRuntimeEnvironment")}
          </button>
          <button
            type="button"
            className={`settings-nav ${activeSection === "other" ? "active" : ""}`}
            onClick={() => setActiveSection("other")}
            title={sidebarCollapsed ? t("settings.sidebarOther") : ""}
          >
            <MoreHorizontalIcon aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarOther")}
          </button>
          {SHOW_EXPERIMENTAL_ENTRY && (
            <>
              <button
                type="button"
                className={`settings-nav ${activeSection === "experimental" ? "active" : ""}`}
                onClick={() => setActiveSection("experimental")}
                title={
                  sidebarCollapsed ? t("settings.sidebarExperimental") : ""
                }
              >
                <FlaskConical aria-hidden />
                {!sidebarCollapsed && t("settings.sidebarExperimental")}
              </button>
            </>
          )}
          <button
            type="button"
            className={`settings-nav ${activeSection === "community" ? "active" : ""}`}
            onClick={() => setActiveSection("community")}
            title={sidebarCollapsed ? t("settings.sidebarCommunity") : ""}
          >
            <Users aria-hidden />
            {!sidebarCollapsed && t("settings.sidebarCommunity")}
          </button>
          <button
            type="button"
            className="settings-sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            aria-label={
              sidebarCollapsed
                ? t("settings.sidebarExpand")
                : t("settings.sidebarCollapse")
            }
            title={
              sidebarCollapsed
                ? t("settings.sidebarExpand")
                : t("settings.sidebarCollapse")
            }
          >
            <span
              className={`codicon ${sidebarCollapsed ? "codicon-chevron-right" : "codicon-chevron-left"}`}
            />
          </button>
        </aside>
        <ScrollArea className="settings-content">
          {shouldShowWorkspaceSelector && (
            <div className="settings-workspace-picker">
              <div className="settings-workspace-picker-label">
                {t("settings.workspacePickerLabel")}
              </div>
              {projects.length > 0 ? (
                <div className="settings-select-wrap">
                  <select
                    className="settings-select"
                    value={selectedSettingsWorkspace?.id ?? ""}
                    onChange={(event) =>
                      setSettingsWorkspaceId(event.target.value || null)
                    }
                  >
                    {projects.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="settings-inline-muted">
                  {t("settings.workspacePickerEmpty")}
                </div>
              )}
            </div>
          )}
          {activeSection === "basic" && (
            <section
              className="settings-section settings-section-basic"
              data-basic-tab={basicSubTab}
            >
              <div className="settings-section-title">
                {t("settings.sidebarBasic")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.basicDescription")}
              </div>
              <div className="settings-basic-tabs">
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "appearance" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("appearance")}
                >
                  <Monitor className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.basicAppearance")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "behavior" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("behavior")}
                >
                  <Cog className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.basicBehavior")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "shortcuts" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("shortcuts")}
                >
                  <Keyboard className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.basicShortcutsTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "open-apps" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("open-apps")}
                >
                  <ExternalLink
                    className="settings-basic-tab-icon"
                    aria-hidden
                  />
                  {t("settings.basicOpenAppsTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "web-service" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("web-service")}
                >
                  <Globe className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.basicWebServiceTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${basicSubTab === "email" ? "active" : ""}`}
                  onClick={() => setBasicSubTab("email")}
                >
                  <Mail className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.basicEmailTab")}
                </button>
              </div>
              <BasicBehaviorSection
                active={basicSubTab === "behavior"}
                t={t}
                appSettings={appSettings}
                onUpdateAppSettings={onUpdateAppSettings}
                handleComposerSendShortcutChange={
                  handleComposerSendShortcutChange
                }
                handleExportDiagnosticsBundle={handleExportDiagnosticsBundle}
                diagnosticsBundleExportState={diagnosticsBundleExportState}
                terminalShellPathDraft={terminalShellPathDraft}
                setTerminalShellPathDraft={setTerminalShellPathDraft}
                terminalShellPathDirty={terminalShellPathDirty}
                handleSaveTerminalShellPath={handleSaveTerminalShellPath}
                handleClearTerminalShellPath={handleClearTerminalShellPath}
                systemProxyEnabledDraft={systemProxyEnabledDraft}
                systemProxyUrlDraft={systemProxyUrlDraft}
                handleToggleSystemProxy={handleToggleSystemProxy}
                handleSystemProxyUrlChange={handleSystemProxyUrlChange}
                handleSaveSystemProxy={handleSaveSystemProxy}
                systemProxySaving={systemProxySaving}
                systemProxyDirty={systemProxyDirty}
                systemProxyNotice={systemProxyNotice}
                systemProxyError={systemProxyError}
                selectedNotificationSound={selectedNotificationSound}
                soundOptions={soundOptions}
                handleNotificationSoundOptionChange={
                  handleNotificationSoundOptionChange
                }
                onTestNotificationSound={onTestNotificationSound}
                notificationSoundPathDraft={notificationSoundPathDraft}
                setNotificationSoundPathDraft={setNotificationSoundPathDraft}
                handleBrowseNotificationSoundPath={
                  handleBrowseNotificationSoundPath
                }
                handleSaveNotificationSoundPath={
                  handleSaveNotificationSoundPath
                }
              />
              {basicSubTab === "appearance" && (
                <BasicAppearanceSection
                  appSettings={appSettings}
                  onUpdateAppSettings={onUpdateAppSettings}
                  windowTransparencyEnabled={
                    windowTransparencyEnabled ?? !reduceTransparency
                  }
                  onToggleWindowTransparency={
                    onToggleWindowTransparency ??
                    ((enabled) => onToggleTransparency(!enabled))
                  }
                  windowOpacity={windowOpacity ?? 88}
                  onWindowOpacityChange={onWindowOpacityChange ?? (() => undefined)}
                  activeThemePresetId={activeThemePresetId}
                  resolvedAppearanceTheme={resolvedAppearanceTheme}
                  themePresetOptions={themePresetOptions}
                  onThemePresetChange={handleThemePresetChange}
                  uiScaleDraft={uiScaleDraft}
                  clampedUiScale={clampedUiScale}
                  uiScaleDraftPercentLabel={uiScaleDraftPercentLabel}
                  setUiScaleDraft={setUiScaleDraft}
                  handleResetUiScaleDraft={handleResetUiScaleDraft}
                  handleSaveUiScale={handleSaveUiScale}
                  scaleShortcutTitle={scaleShortcutTitle}
                  scaleShortcutText={scaleShortcutText}
                  userMsgPresets={userMsgPresets}
                  isUserMsgPresetActive={isUserMsgPresetActive}
                  handleUserMsgPresetClick={handleUserMsgPresetClick}
                  normalizedUserMsgColor={normalizedUserMsgColor}
                  defaultUserMsgColor={defaultUserMsgColor}
                  handleUserMsgColorPickerChange={
                    handleUserMsgColorPickerChange
                  }
                  userMsgHexDraft={userMsgHexDraft}
                  handleUserMsgHexInputChange={handleUserMsgHexInputChange}
                  handleResetUserMsgColor={handleResetUserMsgColor}
                  uiFontDraft={uiFontDraft}
                  handleUiFontSelectChange={handleUiFontSelectChange}
                  uiFontSelectOptions={uiFontSelectOptions}
                  defaultUiPrimaryFont={defaultUiPrimaryFont}
                  setUiFontDraft={setUiFontDraft}
                  codeFontDraft={codeFontDraft}
                  codeFontSelectOptions={codeFontSelectOptions}
                  handleCodeFontSelectChange={handleCodeFontSelectChange}
                  defaultCodePrimaryFont={defaultCodePrimaryFont}
                  setCodeFontDraft={setCodeFontDraft}
                  codeFontSizeDraft={codeFontSizeDraft}
                  setCodeFontSizeDraft={setCodeFontSizeDraft}
                  handleCommitCodeFontSize={handleCommitCodeFontSize}
                />
              )}
              <ShortcutsSection
                active={basicSubTab === "shortcuts"}
                t={t}
                shortcutDrafts={shortcutDrafts}
                handleShortcutKeyDown={handleShortcutKeyDown}
                updateShortcut={updateShortcut}
              />
              <OpenAppsSection
                active={basicSubTab === "open-apps"}
                t={t}
                openAppDrafts={openAppDrafts}
                openAppIconById={openAppIconById}
                openAppSelectedId={openAppSelectedId}
                handleOpenAppDraftChange={handleOpenAppDraftChange}
                handleCommitOpenApps={handleCommitOpenApps}
                handleOpenAppKindChange={handleOpenAppKindChange}
                handleSelectOpenAppDefault={handleSelectOpenAppDefault}
                handleMoveOpenApp={handleMoveOpenApp}
                handleDeleteOpenApp={handleDeleteOpenApp}
                handleAddOpenApp={handleAddOpenApp}
              />
              {basicSubTab === "web-service" && (
                <WebServiceSettings
                  t={t}
                  appSettings={appSettings}
                  onUpdateAppSettings={onUpdateAppSettings}
                />
              )}
              {basicSubTab === "email" && (
                <EmailSenderSettings
                  t={t}
                  appSettings={appSettings}
                  onUpdateAppSettings={onUpdateAppSettings}
                  onOpenMailSession={onOpenMailSession}
                />
              )}
            </section>
          )}
          {activeSection === "project-management" && (
            <section
              className="settings-section settings-section-tabbed"
              data-settings-tab={projectManagementSubTab}
            >
              <div className="settings-section-title">
                {t("settings.sidebarProjectManagement")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.projectManagementDescription")}
              </div>
              <div className="settings-basic-tabs">
                <button
                  type="button"
                  className={`settings-basic-tab ${projectManagementSubTab === "groups" ? "active" : ""}`}
                  onClick={() => setProjectManagementSubTab("groups")}
                >
                  <LayoutGrid className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.projectManagementGroupsTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${projectManagementSubTab === "sessions" ? "active" : ""}`}
                  onClick={() => setProjectManagementSubTab("sessions")}
                >
                  <Archive className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.projectManagementSessionsTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${projectManagementSubTab === "usage" ? "active" : ""}`}
                  onClick={() => setProjectManagementSubTab("usage")}
                >
                  <BarChart3 className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.projectManagementUsageTab")}
                </button>
              </div>
              <ProjectsSection
                active={projectManagementSubTab === "groups"}
                t={t}
                createGroupOpen={createGroupOpen}
                setCreateGroupOpen={setCreateGroupOpen}
                newGroupName={newGroupName}
                setNewGroupName={setNewGroupName}
                canCreateGroup={canCreateGroup}
                handleCreateGroup={handleCreateGroup}
                groupError={groupError}
                workspaceGroups={workspaceGroups}
                handleDragEnd={handleDragEnd}
                renamingGroupId={renamingGroupId}
                setRenamingGroupId={setRenamingGroupId}
                groupDrafts={groupDrafts}
                setGroupDrafts={setGroupDrafts}
                handleRenameGroup={handleRenameGroup}
                handleChooseGroupCopiesFolder={handleChooseGroupCopiesFolder}
                handleClearGroupCopiesFolder={handleClearGroupCopiesFolder}
                handleDeleteGroup={handleDeleteGroup}
                groupedWorkspaces={groupedWorkspaces}
                onAssignWorkspaceGroup={onAssignWorkspaceGroup}
                ungroupedLabel={ungroupedLabel}
                onMoveWorkspace={onMoveWorkspace}
                onDeleteWorkspace={onDeleteWorkspace}
              />
              {projectManagementSubTab === "sessions" && (
                <SessionManagementSection
                  title={t("settings.projectSessionTitle")}
                  description={t("settings.sessionManagementDescription")}
                  appSettings={appSettings}
                  workspaces={sessionWorkspaceOptions}
                  groupedWorkspaces={groupedWorkspaces}
                  initialWorkspaceId={selectedSettingsWorkspace?.id ?? null}
                  onUpdateAppSettings={onUpdateAppSettings}
                  onUpdateWorkspaceSettings={onUpdateWorkspaceSettings}
                  onSessionsMutated={_onEnsureWorkspaceThreads}
                />
              )}
              {projectManagementSubTab === "usage" && (
                <UsageSection
                  activeWorkspace={selectedSettingsWorkspace}
                  activeEngine={activeEngine}
                  workspaces={projects}
                  selectedWorkspaceId={selectedSettingsWorkspace?.id ?? ""}
                  onWorkspaceChange={(workspaceId) =>
                    setSettingsWorkspaceId(workspaceId || null)
                  }
                />
              )}
            </section>
          )}
          {activeSection === "providers" && (
            <VendorSettingsPanel
              appSettings={appSettings}
              codexReloadStatus={codexRuntimeReloadState.status}
              codexReloadMessage={codexRuntimeReloadState.message}
              handleReloadCodexRuntimeConfig={handleReloadCodexRuntimeConfig}
              onUpdateAppSettings={onUpdateAppSettings}
            />
          )}
          {activeSection === "mcp" && (
            <section
              className="settings-section settings-section-tabbed"
              data-settings-tab={mcpManagementSubTab}
            >
              <div className="settings-section-title">
                {t("settings.sidebarMcpSkills")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.mcpSkillsDescription")}
              </div>
              <div className="settings-basic-tabs">
                <button
                  type="button"
                  className={`settings-basic-tab ${mcpManagementSubTab === "servers" ? "active" : ""}`}
                  onClick={() => setMcpManagementSubTab("servers")}
                >
                  <Server className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.mcpPanel.title")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${mcpManagementSubTab === "skills" ? "active" : ""}`}
                  onClick={() => setMcpManagementSubTab("skills")}
                >
                  <BookOpen className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.skillsPanel.title")}
                </button>
              </div>
              {mcpManagementSubTab === "servers" ? (
                <McpSection
                  activeWorkspace={mcpContextWorkspace}
                  activeEngine={activeEngine}
                  embedded
                />
              ) : (
                <>
                  <CuratedSection
                    appSettings={appSettings}
                    onUpdateAppSettings={onUpdateAppSettings}
                  />
                  <SkillsSection
                    activeWorkspace={selectedSettingsWorkspace}
                    embedded
                    appSettings={appSettings}
                    onUpdateAppSettings={onUpdateAppSettings}
                  />
                </>
              )}
            </section>
          )}
          {activeSection === "permissions" && (
            <PlaceholderSection type="permissions" />
          )}
          {activeSection === "commit" && (
            <CommitSection
              commitPrompt={commitPrompt}
              onCommitPromptChange={setCommitPrompt}
              onSaveCommitPrompt={async () => {
                void onUpdateAppSettings({
                  ...appSettings,
                  commitPrompt,
                });
              }}
            />
          )}
          {activeSection === "agent-prompt-management" && (
            <section
              className="settings-section settings-section-tabbed"
              data-settings-tab={agentPromptSubTab}
            >
              <div className="settings-section-title">
                {t("settings.sidebarAgentPromptManagement")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.agentPromptManagementDescription")}
              </div>
              <div className="settings-basic-tabs">
                <button
                  type="button"
                  className={`settings-basic-tab ${agentPromptSubTab === "agents" ? "active" : ""}`}
                  onClick={() => setAgentPromptSubTab("agents")}
                >
                  <Bot className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.agentPromptAgentsTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${agentPromptSubTab === "prompts" ? "active" : ""}`}
                  onClick={() => setAgentPromptSubTab("prompts")}
                >
                  <NotebookPen
                    className="settings-basic-tab-icon"
                    aria-hidden
                  />
                  {t("settings.agentPromptPromptsTab")}
                </button>
              </div>
              <AgentSettingsSection active={agentPromptSubTab === "agents"} />
              {agentPromptSubTab === "prompts" && (
                <PromptSection
                  activeWorkspace={selectedSettingsWorkspace}
                  workspaces={projects}
                  selectedWorkspaceId={selectedSettingsWorkspace?.id ?? null}
                  onWorkspaceChange={(workspaceId) =>
                    setSettingsWorkspaceId(workspaceId || null)
                  }
                />
              )}
            </section>
          )}
          {activeSection === "skills" && (
            <>
              <CuratedSection
                appSettings={appSettings}
                onUpdateAppSettings={onUpdateAppSettings}
              />
              <SkillsSection
                activeWorkspace={selectedSettingsWorkspace}
                embedded
                appSettings={appSettings}
                onUpdateAppSettings={onUpdateAppSettings}
              />
            </>
          )}
          {activeSection === "other" && (
            <OtherSection
              title={t("settings.sidebarOther")}
              description={t("settings.otherDescription")}
              sessionRadarRecentCompletedSessions={
                sessionRadarRecentCompletedSessions
              }
              onDeleteSessionRadarHistory={
                handleDeleteSessionRadarHistoryInSettings
              }
            />
          )}
          {activeSection === "runtime-environment" && (
            <section
              className="settings-section settings-section-tabbed"
              data-settings-tab={runtimeEnvironmentSubTab}
            >
              <div className="settings-section-title">
                {t("settings.sidebarRuntimeEnvironment")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.runtimeEnvironmentDescription")}
              </div>
              <div className="settings-basic-tabs">
                <button
                  type="button"
                  className={`settings-basic-tab ${runtimeEnvironmentSubTab === "runtime-pool" ? "active" : ""}`}
                  onClick={() => setRuntimeEnvironmentSubTab("runtime-pool")}
                >
                  <Boxes className="settings-basic-tab-icon" aria-hidden />
                  {t("settings.runtimeEnvironmentPoolTab")}
                </button>
                <button
                  type="button"
                  className={`settings-basic-tab ${runtimeEnvironmentSubTab === "cli-validation" ? "active" : ""}`}
                  onClick={() => setRuntimeEnvironmentSubTab("cli-validation")}
                >
                  <TerminalSquare
                    className="settings-basic-tab-icon"
                    aria-hidden
                  />
                  {t("settings.runtimeEnvironmentCliValidationTab")}
                </button>
              </div>
              {runtimeEnvironmentSubTab === "runtime-pool" && (
                <RuntimePoolSection
                  t={t}
                  appSettings={appSettings}
                  workspaces={runtimePanelWorkspaces}
                  sessionEngineCounts={runtimeSessionEngineCounts}
                  onUpdateAppSettings={onUpdateAppSettings}
                />
              )}
              <CodexSection
                active={runtimeEnvironmentSubTab === "cli-validation"}
                t={t}
                appSettings={appSettings}
                onUpdateAppSettings={onUpdateAppSettings}
                claudePathDraft={claudePathDraft}
                setClaudePathDraft={setClaudePathDraft}
                claudeDirty={claudeDirty}
                handleBrowseClaude={handleBrowseClaude}
                handleSaveClaudeSettings={handleSaveClaudeSettings}
                handleRunClaudeDoctor={handleRunClaudeDoctor}
                claudeDoctorState={claudeDoctorState}
                codexPathDraft={codexPathDraft}
                setCodexPathDraft={setCodexPathDraft}
                codexArgsDraft={codexArgsDraft}
                setCodexArgsDraft={setCodexArgsDraft}
                codexDirty={codexDirty}
                handleBrowseCodex={handleBrowseCodex}
                handleSaveCodexSettings={handleSaveCodexSettings}
                isSavingSettings={isSavingSettings}
                handleRunDoctor={handleRunDoctor}
                doctorState={doctorState}
                remoteHostDraft={remoteHostDraft}
                setRemoteHostDraft={setRemoteHostDraft}
                remoteTokenDraft={remoteTokenDraft}
                setRemoteTokenDraft={setRemoteTokenDraft}
                handleCommitRemoteHost={handleCommitRemoteHost}
                handleCommitRemoteToken={handleCommitRemoteToken}
                workspaces={runtimePanelWorkspaces}
                activeWorkspace={activeWorkspace}
                onUpdateWorkspaceCodexBin={onUpdateWorkspaceCodexBin}
                onUpdateWorkspaceSettings={onUpdateWorkspaceSettings}
                onInstallerDoctorResult={(engine, result) => {
                  if (!result) {
                    return;
                  }
                  if (engine === "codex") {
                    setDoctorState({ status: "done", result });
                  } else {
                    setClaudeDoctorState({ status: "done", result });
                  }
                }}
              />
            </section>
          )}
          {activeSection === "community" && (
            <section className="settings-section settings-about-section">
              <div className="settings-about-name">
                CodePort
                {appVersion && (
                  <span className="settings-about-version">{appVersion}</span>
                )}
              </div>
              <div className="settings-about-tagline">{t("about.tagline")}</div>
              <div className="settings-about-links">
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    void openUrl(
                      "https://github.com/zhukunpenglinyutong/desktop-cc-gui",
                    )
                  }
                >
                  {t("about.github")}
                </button>
              </div>
              <div className="settings-about-wechat">
                <div className="settings-about-wechat-label">
                  {t("about.wechatGroupTitle")}
                </div>
                <img
                  className="settings-about-wechat-qr"
                  src={wxqImage}
                  alt={t("about.wechatGroupTitle")}
                />
              </div>
            </section>
          )}
          <ComposerSection
            active={activeSection === "composer"}
            t={t}
            appSettings={appSettings}
            onUpdateAppSettings={onUpdateAppSettings}
            handleComposerPresetChange={handleComposerPresetChange}
            handleComposerSendShortcutChange={handleComposerSendShortcutChange}
            historyCompletionEnabled={historyCompletionEnabled}
            handleHistoryCompletionToggle={handleHistoryCompletionToggle}
            reduceTransparency={reduceTransparency}
          />
          <DictationSection
            active={activeSection === "dictation"}
            t={t}
            appSettings={appSettings}
            onUpdateAppSettings={onUpdateAppSettings}
            dictationModelStatus={dictationModelStatus}
            onDownloadDictationModel={onDownloadDictationModel}
            onCancelDictationDownload={onCancelDictationDownload}
            onRemoveDictationModel={onRemoveDictationModel}
          />
          {activeSection === "git" && (
            <section className="settings-section">
              <div className="settings-section-title">
                {t("settings.gitTitle")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.gitDescription")}
              </div>
              <DetachedExternalChangeToggles
                t={t}
                appSettings={appSettings}
                onUpdateAppSettings={onUpdateAppSettings}
              />
            </section>
          )}
          {/* vendors is now mapped to providers above */}
          {/* about is now mapped to community above */}
          {activeSection === "experimental" && (
            <section className="settings-section">
              <div className="settings-section-title">
                {t("settings.experimentalTitle")}
              </div>
              <div className="settings-section-subtitle">
                {t("settings.experimentalDescription")}
              </div>
              {hasCodexHomeOverrides && (
                <div className="settings-help">
                  {t("settings.experimentalWarning1")}
                  <br />
                  {t("settings.experimentalWarning2")}
                </div>
              )}
              <ExperimentalToggleRow
                title={t("settings.collaborationModes")}
                description={t("settings.collaborationModesDesc")}
                markerLabel={t("settings.experimentalBadgeRecommended")}
                markerTone="success"
                markerDetail={t("settings.collaborationModesMarkerDesc")}
                highlighted={
                  highlightedRow === "experimental-collaboration-modes"
                }
                checked={appSettings.experimentalCollaborationModesEnabled}
                onCheckedChange={(checked) =>
                  void onUpdateAppSettings({
                    ...appSettings,
                    experimentalCollaborationModesEnabled: checked,
                  })
                }
              />
              <ExperimentalToggleRow
                title={t("settings.steerMode")}
                description={t("settings.steerModeDesc")}
                markerLabel={t("settings.experimentalBadgeAvailable")}
                markerTone="success"
                markerDetail={t("settings.steerModeMarkerDesc")}
                checked={appSettings.experimentalSteerEnabled}
                onCheckedChange={(checked) =>
                  void onUpdateAppSettings({
                    ...appSettings,
                    experimentalSteerEnabled: checked,
                  })
                }
              />
            </section>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
