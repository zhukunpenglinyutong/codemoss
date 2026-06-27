// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  DiagnosticsBundleExportResult,
  WorkspaceInfo,
} from "../../../types";
import {
  archiveWorkspaceSessions,
  deleteWorkspaceSessions,
  exportDiagnosticsBundle,
  getDaemonStatus,
  getWorkspaceSessionProjectionSummary,
  getEmailSenderSettings,
  getWebServerStatus,
  listWorkspaceSessionFolders,
  listWorkspaceSessions,
  unarchiveWorkspaceSessions,
} from "../../../services/tauri";
import { writeClientStoreValue } from "../../../services/clientStorage";
import { pushErrorToast } from "../../../services/toasts";
import { SettingsView } from "./SettingsView";

const skillsSectionMock = vi.fn();

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => new Promise<string>(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../../../i18n", () => ({
  saveLanguage: vi.fn(),
  default: {
    use: () => ({ init: vi.fn() }),
  },
}));

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

vi.mock("@/features/computer-use/components/ComputerUseStatusCard", () => ({
  ComputerUseStatusCard: () => <div data-testid="computer-use-status-card" />,
}));

vi.mock("./McpSection", () => ({
  McpSection: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid={embedded ? "embedded-mcp-section" : "mcp-section"}>
      Mock MCP Section
    </div>
  ),
}));

vi.mock("../../curated-skills/components/CuratedSection", () => ({
  CuratedSection: () => <div data-testid="curated-section-stub">Mock Curated Section</div>,
}));

vi.mock("../../curated-skills/hooks/useCuratedSkills", () => ({
  useCuratedSkills: () => ({
    skills: [],
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
  }),
}));

vi.mock("./SkillsSection", () => ({
  SkillsSection: (props: {
    embedded?: boolean;
    appSettings?: AppSettings;
    onUpdateAppSettings?: unknown;
  }) => {
    skillsSectionMock(props);
    return (
      <div
        data-testid={
          props.embedded ? "embedded-skills-section" : "skills-section"
        }
      >
        Mock Skills Section
      </div>
    );
  },
}));

vi.mock("../../../services/tauri", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/tauri")
  >("../../../services/tauri");
  return {
    ...actual,
    getWorkspaceSessionProjectionSummary: vi.fn(),
    listWorkspaceSessionFolders: vi.fn(),
    listWorkspaceSessions: vi.fn(),
    archiveWorkspaceSessions: vi.fn(),
    unarchiveWorkspaceSessions: vi.fn(),
    deleteWorkspaceSessions: vi.fn(),
    exportDiagnosticsBundle: vi.fn(),
    getWebServerStatus: vi.fn(),
    getDaemonStatus: vi.fn(),
    getEmailSenderSettings: vi.fn(),
  };
});

const mockedLocalFonts = [
  { family: "Monaco" },
  { family: "Avenir" },
  { family: "SF Pro Text" },
] as const;

const queryLocalFontsMock = vi.fn<() => Promise<Array<{ family: string }>>>(
  () => new Promise<Array<{ family: string }>>(() => {}),
);

const createDeferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  skillsSectionMock.mockClear();
  queryLocalFontsMock.mockReset();
  queryLocalFontsMock.mockImplementation(
    () => new Promise<Array<{ family: string }>>(() => {}),
  );
  (window as any).queryLocalFonts = queryLocalFontsMock;
  vi.mocked(listWorkspaceSessions).mockResolvedValue({
    data: [],
    nextCursor: null,
    partialSource: null,
  });
  vi.mocked(listWorkspaceSessionFolders).mockResolvedValue({
    workspaceId: "ws-1",
    folders: [],
  });
  vi.mocked(getWorkspaceSessionProjectionSummary).mockResolvedValue({
    scopeKind: "project",
    ownerWorkspaceIds: ["ws-1"],
    activeTotal: 0,
    archivedTotal: 0,
    allTotal: 0,
    filteredTotal: 0,
    folderCountsById: {},
    unassignedFolderCount: 0,
    partialSources: [],
  });
  vi.mocked(archiveWorkspaceSessions).mockResolvedValue({ results: [] });
  vi.mocked(unarchiveWorkspaceSessions).mockResolvedValue({ results: [] });
  vi.mocked(deleteWorkspaceSessions).mockResolvedValue({ results: [] });
  vi.mocked(exportDiagnosticsBundle).mockResolvedValue({
    filePath: "/tmp/diagnostics.json",
    generatedAt: "123",
  });
  vi.mocked(getWebServerStatus).mockResolvedValue({
    running: false,
    rpcEndpoint: "127.0.0.1:4732",
    webPort: 3080,
    addresses: [],
    webAccessToken: null,
    lastError: null,
  });
  vi.mocked(getDaemonStatus).mockResolvedValue({
    running: false,
    host: "127.0.0.1:4732",
    lastError: null,
  });
  vi.mocked(getEmailSenderSettings).mockResolvedValue({
    settings: baseSettings.emailSender,
    secretConfigured: false,
    secret: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as any).queryLocalFonts;
});

const workspaceA: WorkspaceInfo = {
  id: "ws-a",
  name: "Workspace A",
  path: "/tmp/ws-a",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const workspaceB: WorkspaceInfo = {
  id: "ws-b",
  name: "Workspace B",
  path: "/tmp/ws-b",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const baseSettings: AppSettings = {
  claudeBin: null,
  codexBin: null,
  codexArgs: null,
  terminalShellPath: null,
  geminiEnabled: true,
  opencodeEnabled: true,
  browserAgentEnabled: true,
  browserAgentPreferBuiltIn: true,
  browserAgentAllowExternalProviderFallback: true,
  backendMode: "local",
  remoteBackendHost: "127.0.0.1:4732",
  remoteBackendToken: null,
  webServicePort: 3080,
  webServiceToken: null,
  systemProxyEnabled: false,
  systemProxyUrl: null,
  defaultAccessMode: "current",
  composerModelShortcut: null,
  composerAccessShortcut: null,
  composerReasoningShortcut: null,
  composerCollaborationShortcut: null,
  interruptShortcut: null,
  openSettingsShortcut: null,
  newWindowShortcut: null,
  newAgentShortcut: null,
  newWorktreeAgentShortcut: null,
  newCloneAgentShortcut: null,
  archiveThreadShortcut: null,
  closeCurrentSessionShortcut: null,
  openChatShortcut: null,
  openKanbanShortcut: null,
  cycleOpenSessionPrevShortcut: null,
  cycleOpenSessionNextShortcut: null,
  toggleLeftConversationSidebarShortcut: null,
  toggleRightConversationSidebarShortcut: null,
  toggleProjectsSidebarShortcut: null,
  toggleGitSidebarShortcut: null,
  toggleGlobalSearchShortcut: null,
  toggleDebugPanelShortcut: null,
  toggleTerminalShortcut: null,
  toggleRuntimeConsoleShortcut: null,
  toggleFilesSurfaceShortcut: null,
  saveFileShortcut: null,
  findInFileShortcut: null,
  toggleGitDiffListViewShortcut: null,
  increaseUiScaleShortcut: null,
  decreaseUiScaleShortcut: null,
  resetUiScaleShortcut: null,
  cycleAgentNextShortcut: null,
  cycleAgentPrevShortcut: null,
  cycleWorkspaceNextShortcut: null,
  cycleWorkspacePrevShortcut: null,
  lastComposerModelId: null,
  lastComposerReasoningEffort: null,
  uiScale: 1,
  theme: "system",
  lightThemePresetId: "vscode-light-modern",
  darkThemePresetId: "vscode-dark-modern",
  customThemePresetId: "vscode-dark-modern",
  customSkillDirectories: [],
  canvasWidthMode: "narrow",
  layoutMode: "default",
  userMsgColor: "",
  usageShowRemaining: false,
  showMessageAnchors: true,
  showSidebarProviderLabels: false,
  performanceCompatibilityModeEnabled: false,
  uiFontFamily:
    'Monaco, "SF Pro Text", "SF Pro Display", -apple-system, "Helvetica Neue", sans-serif',
  codeFontFamily: 'Monaco, "SF Mono", "SFMono-Regular", Menlo, monospace',
  codeFontSize: 11,
  notificationSoundsEnabled: true,
  notificationSoundId: "default",
  notificationSoundCustomPath: "",
  systemNotificationEnabled: true,
  emailSender: {
    enabled: false,
    provider: "custom",
    senderEmail: "",
    senderName: "",
    smtpHost: "",
    smtpPort: 465,
    security: "ssl_tls",
    username: "",
    recipientEmail: "",
  },
  runtimeRestoreThreadsOnlyOnLaunch: true,
  runtimeForceCleanupOnExit: true,
  runtimeOrphanSweepOnLaunch: true,
  codexMaxHotRuntimes: 1,
  codexMaxWarmRuntimes: 1,
  codexWarmTtlSeconds: 7200,
  codexAutoCompactionEnabled: true,
  codexAutoCompactionThresholdPercent: 92,
  preloadGitDiffs: true,
  experimentalCollabEnabled: false,
  experimentalCollaborationModesEnabled: false,
  experimentalSteerEnabled: false,
  codexUnifiedExecPolicy: "inherit",
  chatCanvasUseNormalizedRealtime: true,
  chatCanvasUseUnifiedHistoryLoader: true,
  chatCanvasUsePresentationProfile: false,
  dictationEnabled: false,
  dictationModelId: "base",
  dictationPreferredLanguage: null,
  dictationHoldKey: null,
  composerEditorPreset: "default",
  composerSendShortcut: "enter",
  composerFenceExpandOnSpace: false,
  composerFenceExpandOnEnter: false,
  composerFenceLanguageTags: false,
  composerFenceWrapSelection: false,
  composerFenceAutoWrapPasteMultiline: false,
  composerFenceAutoWrapPasteCodeLike: false,
  composerListContinuation: false,
  composerCodeBlockCopyUseModifier: false,
  workspaceGroups: [],
  openAppTargets: [
    {
      id: "vscode",
      label: "VS Code",
      kind: "app",
      appName: "Visual Studio Code",
      command: null,
      args: [],
    },
  ],
  selectedOpenAppId: "vscode",
};

const createDoctorResult = () => ({
  ok: true,
  codexBin: null,
  version: null,
  appServerOk: true,
  appServerProbeStatus: "ok",
  details: null,
  path: null,
  pathEnvUsed: null,
  proxyEnvSnapshot: undefined,
  nodeOk: true,
  nodeVersion: null,
  nodeDetails: null,
  resolvedBinaryPath: null,
  wrapperKind: null,
  fallbackRetried: false,
});

const renderDisplaySection = (
  options: {
    appSettings?: Partial<AppSettings>;
    reduceTransparency?: boolean;
    onUpdateAppSettings?: ComponentProps<
      typeof SettingsView
    >["onUpdateAppSettings"];
    onToggleTransparency?: ComponentProps<
      typeof SettingsView
    >["onToggleTransparency"];
    windowTransparencyEnabled?: boolean;
    onToggleWindowTransparency?: ComponentProps<
      typeof SettingsView
    >["onToggleWindowTransparency"];
    windowOpacity?: number;
    onWindowOpacityChange?: ComponentProps<
      typeof SettingsView
    >["onWindowOpacityChange"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const onToggleTransparency = options.onToggleTransparency ?? vi.fn();
  const onToggleWindowTransparency =
    options.onToggleWindowTransparency ?? vi.fn();
  const onWindowOpacityChange = options.onWindowOpacityChange ?? vi.fn();
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: options.reduceTransparency ?? false,
    onToggleTransparency,
    windowTransparencyEnabled:
      options.windowTransparencyEnabled ?? !(options.reduceTransparency ?? false),
    onToggleWindowTransparency,
    windowOpacity: options.windowOpacity ?? 88,
    onWindowOpacityChange,
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    activeWorkspace: null,
    activeEngine: "codex",
    onUpdateWorkspaceCodexBin: vi.fn().mockResolvedValue(undefined),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
  };

  const view = render(<SettingsView {...props} />);

  return {
    ...view,
    onUpdateAppSettings,
    onToggleTransparency,
    onToggleWindowTransparency,
    onWindowOpacityChange,
  };
};

const renderComposerSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    onUpdateAppSettings?: ComponentProps<
      typeof SettingsView
    >["onUpdateAppSettings"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    activeWorkspace: null,
    activeEngine: "codex",
    onUpdateWorkspaceCodexBin: vi.fn().mockResolvedValue(undefined),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
    initialSection: "composer",
  };

  render(<SettingsView {...props} />);

  return { onUpdateAppSettings };
};

const flushSettingsViewEffects = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("SettingsView prompts workspace routing", () => {
  it("aligns prompt settings workspace picker to the active workspace when opened from prompts", async () => {
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[
          { id: null, name: "Ungrouped", workspaces: [workspaceA, workspaceB] },
        ]}
        allWorkspaces={[workspaceA, workspaceB]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspaceB}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="agent-prompt-management"
        initialHighlightTarget="prompt-library"
      />,
    );

    const picker = await screen.findByDisplayValue("Workspace B");
    expect(picker).toBeTruthy();
  });
});

describe("SettingsView projects display", () => {
  it("hides default workspace entry in projects section", async () => {
    const defaultWorkspace: WorkspaceInfo = {
      id: "ws-default",
      name: "Default Hidden Workspace",
      path: "/Users/demo/.ccgui/workspace",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    const normalWorkspace: WorkspaceInfo = {
      id: "ws-normal",
      name: "Visible Workspace",
      path: "/tmp/visible-workspace",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Ungrouped",
            workspaces: [defaultWorkspace, normalWorkspace],
          },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={normalWorkspace}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="project-management"
      />,
    );

    await flushSettingsViewEffects();
    expect(screen.queryByText("Default Hidden Workspace")).toBeNull();
    expect(screen.getByText("Visible Workspace")).toBeTruthy();
  });
});

describe("SettingsView Display", () => {
  it("shows consolidated settings entries and keeps removed sidebar entries hidden", async () => {
    renderDisplaySection();
    await flushSettingsViewEffects();
    const sidebar = document.querySelector(
      ".settings-sidebar",
    ) as HTMLElement | null;
    if (!sidebar) {
      throw new Error("Expected settings sidebar");
    }
    const sidebarQueries = within(sidebar);

    expect(
      sidebarQueries.queryByRole("button", { name: "Dictation" }),
    ).toBeNull();
    expect(sidebarQueries.queryByRole("button", { name: "Git" })).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Projects" }),
    ).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Sessions" }),
    ).toBeNull();
    expect(sidebarQueries.queryByRole("button", { name: "Agents" })).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Prompts" }),
    ).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Shortcuts" }),
    ).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Open in" }),
    ).toBeNull();
    expect(sidebarQueries.queryByRole("button", { name: "Usage" })).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Web Service" }),
    ).toBeNull();
    expect(sidebarQueries.queryByRole("button", { name: "Email" })).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "Runtime Pool" }),
    ).toBeNull();
    expect(
      sidebarQueries.queryByRole("button", { name: "CLI Validation" }),
    ).toBeNull();
    expect(sidebarQueries.queryByRole("button", { name: "Skills" })).toBeNull();
    expect(
      sidebarQueries.getByRole("button", { name: "Project Management" }),
    ).toBeTruthy();
    expect(
      sidebarQueries.getByRole("button", { name: "MCP / Skills" }),
    ).toBeTruthy();
    expect(
      sidebarQueries.getByRole("button", { name: "Agents / Prompts" }),
    ).toBeTruthy();
    expect(
      sidebarQueries.getByRole("button", { name: "Runtime Environment" }),
    ).toBeTruthy();
    expect(
      sidebarQueries.queryByRole("button", { name: "Experimental" }),
    ).toBeNull();
  });

  it("removes the dead multi-agent toggle and no longer shows background terminal in experimental", async () => {
    cleanup();
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Ungrouped",
            workspaces: [
              {
                ...workspaceA,
                settings: {
                  ...workspaceA.settings,
                  codexHome: "/tmp/custom-codex-home",
                },
              },
            ],
          },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="experimental"
      />,
    );

    await flushSettingsViewEffects();

    expect(screen.queryByText("Multi-agent")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Background terminal" }),
    ).toBeNull();
    expect(screen.queryByText("Background terminal")).toBeNull();
  });

  it("adds recommendation markers for experimental toggles", async () => {
    cleanup();
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspaceA}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="experimental"
      />,
    );

    await flushSettingsViewEffects();

    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(
      screen.getByText(
        "This already feeds the main interaction path and is enabled by default; keep it on if you want Plan mode.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This is already wired into same-run continuation, queued send, and queue fusion. Turn it on if you often keep asking follow-ups while an answer is still streaming.",
      ),
    ).toBeTruthy();
  });

  it("renders codex doctor probe metadata including proxy context", async () => {
    cleanup();
    const onRunDoctor = vi.fn().mockResolvedValue({
      ...createDoctorResult(),
      version: "1.0.0",
      path: "/usr/local/bin:/usr/bin",
      pathEnvUsed: "/usr/local/bin:/usr/bin",
      resolvedBinaryPath: "C:/Users/test/AppData/Roaming/npm/codex.cmd",
      wrapperKind: "cmd-wrapper",
      fallbackRetried: true,
      proxyEnvSnapshot: {
        HTTP_PROXY: "http://127.0.0.1:7890",
        HTTPS_PROXY: null,
      },
      appServerProbeStatus: "fallback-ok",
    });
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={onRunDoctor}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="runtime-environment"
        initialHighlightTarget="cli-validation"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run doctor" }));

    await waitFor(() => {
      expect(onRunDoctor).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(document.querySelector(".settings-doctor-body")).toBeTruthy();
    });
    const doctorBodyText =
      document.querySelector(".settings-doctor-body")?.textContent ?? "";
    expect(doctorBodyText).toContain("App Server Probe: fallback-ok");
    expect(doctorBodyText).toContain(
      "Resolved Binary: C:/Users/test/AppData/Roaming/npm/codex.cmd",
    );
    expect(doctorBodyText).toContain("Wrapper Kind: cmd-wrapper");
    expect(doctorBodyText).toContain("Wrapper Fallback Retry: attempted");
    expect(doctorBodyText).toContain("HTTP_PROXY=http://127.0.0.1:7890");
    expect(doctorBodyText).not.toContain("HTTPS_PROXY=Not set");
  });

  it("switches to the Claude Code tab and runs Claude doctor", async () => {
    cleanup();
    const onRunClaudeDoctor = vi.fn().mockResolvedValue({
      ...createDoctorResult(),
      version: "0.9.0",
    });
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunClaudeDoctor={onRunClaudeDoctor}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="runtime-environment"
        initialHighlightTarget="cli-validation"
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Run Claude Doctor" }));

    await waitFor(() => {
      expect(onRunClaudeDoctor).toHaveBeenCalled();
    });
  });

  it("renders doctor results even when debug payload is partial", async () => {
    cleanup();
    const onRunDoctor = vi.fn().mockResolvedValue({
      ...createDoctorResult(),
      debug: {
        platform: "darwin",
        arch: "arm64",
      },
    });
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={onRunDoctor}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="runtime-environment"
        initialHighlightTarget="cli-validation"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run doctor" }));

    await waitFor(() => {
      expect(onRunDoctor).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        document.querySelector(".settings-doctor-body")?.textContent ?? "",
      ).toContain("Platform:");
    });
  });

  it("keeps execution backend controls shared across Codex and Claude tabs", async () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={{ ...baseSettings, backendMode: "remote" }}
        openAppIconById={{}}
        onUpdateAppSettings={onUpdateAppSettings}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunClaudeDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="runtime-environment"
        initialHighlightTarget="cli-validation"
      />,
    );

    expect(screen.getByText("Execution backend")).toBeTruthy();
    expect(screen.getByLabelText("Remote backend host")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));

    expect(screen.getByLabelText("Remote backend host")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Backend mode"), {
      target: { value: "local" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ backendMode: "local" }),
      );
    });
  });

  it("hides deprecated Gemini and OpenCode entries inside CLI validation tabs", () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={onUpdateAppSettings}
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunClaudeDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="runtime-environment"
        initialHighlightTarget="cli-validation"
      />,
    );

    expect(screen.getByRole("tab", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Claude Code" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Gemini CLI" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "OpenCode CLI" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Gemini CLI" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "OpenCode CLI" })).toBeNull();
    expect(onUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("updates the theme selection", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      );
    });
  });

  it("persists terminal shell path from behavior settings", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const basicSection = document.querySelector(".settings-section-basic");
    const behaviorTab = basicSection?.querySelectorAll(
      ".settings-basic-tab",
    )[1];
    if (!(behaviorTab instanceof HTMLElement)) {
      throw new Error("Expected behavior tab");
    }
    await act(async () => {
      fireEvent.click(behaviorTab);
    });
    await waitFor(() => {
      expect(screen.getByText("Terminal shell")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Terminal shell path"), {
      target: { value: "  C:\\Program Files\\PowerShell\\7\\pwsh.exe  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save terminal shell path" }),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        }),
      );
    });
  });

  it("toggles low-performance compatibility mode from behavior settings", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { performanceCompatibilityModeEnabled: false },
    });

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Enable low-performance compatibility mode",
      }),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          performanceCompatibilityModeEnabled: true,
        }),
      );
    });
  });

  it("exports diagnostics bundle from behavior settings", async () => {
    renderDisplaySection();

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => {
      expect(exportDiagnosticsBundle).toHaveBeenCalledTimes(1);
    });
    expect((await screen.findByRole("status")).textContent ?? "").toContain(
      "/tmp/diagnostics.json",
    );
  });

  it("shows a readable diagnostics bundle export failure", async () => {
    vi.mocked(exportDiagnosticsBundle).mockRejectedValueOnce(
      new Error("disk full"),
    );
    renderDisplaySection();

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent ?? "").toContain(
        "disk full",
      );
    });
  });

  it("keeps the latest diagnostics bundle export result when responses settle out of order", async () => {
    const firstExport = createDeferred<DiagnosticsBundleExportResult>();
    const secondExport = createDeferred<DiagnosticsBundleExportResult>();
    vi.mocked(exportDiagnosticsBundle)
      .mockReturnValueOnce(firstExport.promise)
      .mockReturnValueOnce(secondExport.promise);
    renderDisplaySection();

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    const exportButton = screen.getByRole("button", {
      name: "Export diagnostics",
    });
    await act(async () => {
      fireEvent.click(exportButton);
      fireEvent.click(exportButton);
    });

    expect(exportDiagnosticsBundle).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondExport.resolve({
        filePath: "/tmp/new-diagnostics.json",
        generatedAt: "2",
      });
    });
    expect((await screen.findByRole("status")).textContent ?? "").toContain(
      "/tmp/new-diagnostics.json",
    );

    await act(async () => {
      firstExport.resolve({
        filePath: "/tmp/old-diagnostics.json",
        generatedAt: "1",
      });
    });
    expect(screen.getByRole("status").textContent ?? "").toContain(
      "/tmp/new-diagnostics.json",
    );
    expect(screen.getByRole("status").textContent ?? "").not.toContain(
      "/tmp/old-diagnostics.json",
    );
  });

  it("ignores diagnostics bundle export completion after settings unmount", async () => {
    const pendingExport = createDeferred<DiagnosticsBundleExportResult>();
    vi.mocked(exportDiagnosticsBundle).mockReturnValueOnce(
      pendingExport.promise,
    );
    const { unmount } = renderDisplaySection();

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    unmount();

    await act(async () => {
      pendingExport.resolve({
        filePath: "/tmp/unmounted-diagnostics.json",
        generatedAt: "1",
      });
    });

    expect(screen.queryByText("/tmp/unmounted-diagnostics.json")).toBeNull();
  });

  it("updates the active theme preset for dark appearance", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: {
        theme: "custom",
        customThemePresetId: "vscode-dark-modern",
      },
    });

    fireEvent.change(screen.getByLabelText("Theme Palette"), {
      target: { value: "vscode-dark-plus" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          customThemePresetId: "vscode-dark-plus",
          lightThemePresetId: "vscode-light-modern",
          darkThemePresetId: "vscode-dark-modern",
        }),
      );
    });
  });

  it("updates the active theme preset for light appearance", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: {
        theme: "custom",
        customThemePresetId: "vscode-light-modern",
      },
    });

    fireEvent.change(screen.getByLabelText("Theme Palette"), {
      target: { value: "vscode-light-plus" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          customThemePresetId: "vscode-light-plus",
          lightThemePresetId: "vscode-light-modern",
          darkThemePresetId: "vscode-dark-modern",
        }),
      );
    });
  });

  it("shows the theme palette only for custom theme and lists all presets", async () => {
    renderDisplaySection({
      appSettings: { theme: "light" },
    });

    expect(screen.queryByLabelText("Theme Palette")).toBeNull();

    renderDisplaySection({
      appSettings: {
        theme: "custom",
        customThemePresetId: "vscode-light-modern",
      },
    });

    const select = screen.getByLabelText("Theme Palette");
    const options = within(select).getAllByRole("option");

    expect(options.map((option) => option.getAttribute("value"))).toEqual([
      "vscode-light-modern",
      "vscode-light-plus",
      "vscode-github-light",
      "vscode-solarized-light",
      "vscode-catppuccin-latte",
      "vscode-tokyo-day",
      "vscode-rose-pine-dawn",
      "vscode-everforest-light",
      "vscode-ayu-light",
      "vscode-dark-modern",
      "vscode-dark-plus",
      "vscode-github-dark",
      "vscode-github-dark-dimmed",
      "vscode-one-dark-pro",
      "vscode-monokai",
      "vscode-solarized-dark",
      "vscode-dracula",
      "vscode-nord",
      "vscode-catppuccin-mocha",
      "vscode-tokyo-night",
      "vscode-rose-pine",
    ]);
  });

  it("updates the canvas width mode selection", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Wide canvas" }));
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ canvasWidthMode: "wide" }),
      );
    });
  });

  it("switches canvas width mode from wide back to narrow", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { canvasWidthMode: "wide" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Narrow canvas" }));
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ canvasWidthMode: "narrow" }),
      );
    });
  });

  it("updates the layout mode selection", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Left on right" }));
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ layoutMode: "swapped" }),
      );
    });
  });

  it("switches layout mode from swapped back to default", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { layoutMode: "swapped" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Default layout" }));
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ layoutMode: "default" }),
      );
    });
  });

  it("persists client UI visibility panel and control toggles", async () => {
    renderDisplaySection();

    expect(screen.getByText("Client UI visibility")).toBeTruthy();
    expect(screen.getByText("Conversation canvas")).toBeTruthy();
    expect(screen.getByText("Runtime notice dock")).toBeTruthy();
    expect(screen.getByText("Context sources card")).toBeTruthy();

    const topSessionTabsRow = screen
      .getByText("Top session tabs")
      .closest(".settings-toggle-row") as HTMLElement | null;
    const terminalRow = screen
      .getByText("Terminal shortcut")
      .closest(".settings-toggle-row") as HTMLElement | null;
    const contextSourcesCardRow = screen
      .getByText("Context sources card")
      .closest(".settings-toggle-row") as HTMLElement | null;
    const runtimeNoticeDockRow = screen
      .getByText("Runtime notice dock")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (
      !topSessionTabsRow ||
      !terminalRow ||
      !contextSourcesCardRow ||
      !runtimeNoticeDockRow
    ) {
      throw new Error("Expected client UI visibility rows");
    }
    expect(
      topSessionTabsRow.querySelector(
        ".settings-client-ui-visibility-row-icon svg",
      ),
    ).toBeTruthy();
    expect(
      terminalRow.querySelector(".settings-client-ui-visibility-row-icon svg"),
    ).toBeTruthy();
    expect(
      contextSourcesCardRow.querySelector(
        ".settings-client-ui-visibility-row-icon svg",
      ),
    ).toBeTruthy();
    expect(
      runtimeNoticeDockRow.querySelector(
        ".settings-client-ui-visibility-row-icon svg",
      ),
    ).toBeTruthy();

    fireEvent.click(within(topSessionTabsRow).getByRole("switch"));
    await waitFor(() => {
      expect(writeClientStoreValue).toHaveBeenCalledWith(
        "app",
        "clientUiVisibility",
        expect.objectContaining({
          panels: expect.objectContaining({ topSessionTabs: false }),
        }),
        { immediate: true },
      );
    });

    fireEvent.click(within(terminalRow).getByRole("switch"));
    await waitFor(() => {
      expect(writeClientStoreValue).toHaveBeenCalledWith(
        "app",
        "clientUiVisibility",
        expect.objectContaining({
          controls: expect.objectContaining({ "topTool.terminal": false }),
        }),
        { immediate: true },
      );
    });

    fireEvent.click(within(contextSourcesCardRow).getByRole("switch"));
    await waitFor(() => {
      expect(writeClientStoreValue).toHaveBeenCalledWith(
        "app",
        "clientUiVisibility",
        expect.objectContaining({
          controls: expect.objectContaining({ "curtain.contextLedger": false }),
        }),
        { immediate: true },
      );
    });

    fireEvent.click(within(runtimeNoticeDockRow).getByRole("switch"));
    await waitFor(() => {
      expect(writeClientStoreValue).toHaveBeenCalledWith(
        "app",
        "clientUiVisibility",
        expect.objectContaining({
          panels: expect.objectContaining({ globalRuntimeNoticeDock: false }),
        }),
        { immediate: true },
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Restore default visibility" }),
    );
    await waitFor(() => {
      expect(writeClientStoreValue).toHaveBeenLastCalledWith(
        "app",
        "clientUiVisibility",
        { panels: {}, controls: { "topTool.clientDocumentation": false } },
        { immediate: true },
      );
    });
  });

  it("updates user message color using reference-compatible format", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const appRoot = document.createElement("div");
    appRoot.className = "app reduced-transparency";
    document.body.appendChild(appRoot);
    renderDisplaySection({ onUpdateAppSettings });

    fireEvent.click(
      screen.getByTestId("settings-user-msg-color-preset-6e40c9"),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ userMsgColor: "#6e40c9" }),
      );
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--color-message-user-bg",
      ),
    ).toBe("#6e40c9");
    expect(appRoot.style.getPropertyValue("--color-message-user-bg")).toBe(
      "#6e40c9",
    );

    fireEvent.change(screen.getByTestId("settings-user-msg-color-hex-input"), {
      target: { value: "#cf222e" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ userMsgColor: "#cf222e" }),
      );
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--color-message-user-bg",
      ),
    ).toBe("#cf222e");
    expect(appRoot.style.getPropertyValue("--color-message-user-bg")).toBe(
      "#cf222e",
    );

    const callCountBeforeInvalid = onUpdateAppSettings.mock.calls.length;
    fireEvent.change(screen.getByTestId("settings-user-msg-color-hex-input"), {
      target: { value: "#zzzzzz" },
    });

    expect(onUpdateAppSettings).toHaveBeenCalledTimes(callCountBeforeInvalid);
    appRoot.remove();
  });

  it("hides remaining limits and message anchors while showing window transparency controls", async () => {
    renderDisplaySection();
    await flushSettingsViewEffects();

    expect(screen.queryByText("Show remaining Codex limits")).toBeNull();
    expect(screen.queryByText("Show message anchors")).toBeNull();
    expect(screen.queryByText("Reduce transparency")).toBeNull();
    expect(screen.getByText("Window transparency")).toBeTruthy();
    expect(screen.getByLabelText("Overall opacity")).toBeTruthy();
  });

  it("updates window transparency toggle and opacity", async () => {
    const onToggleWindowTransparency = vi.fn();
    const onWindowOpacityChange = vi.fn();
    renderDisplaySection({
      windowTransparencyEnabled: false,
      onToggleWindowTransparency,
      onWindowOpacityChange,
    });

    fireEvent.click(screen.getByRole("switch", { name: "Window transparency" }));

    expect(onToggleWindowTransparency).toHaveBeenCalledWith(true);
    expect(screen.queryByLabelText("Overall opacity")).toBeNull();

    cleanup();
    renderDisplaySection({
      windowTransparencyEnabled: true,
      windowOpacity: 88,
      onToggleWindowTransparency,
      onWindowOpacityChange,
    });

    fireEvent.change(screen.getByLabelText("Overall opacity"), {
      target: { value: "72" },
    });

    expect(onWindowOpacityChange).toHaveBeenCalledWith(72);
  });

  it("updates ui scale from slider and save action", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const fontSizeSlider = screen.getByLabelText("Interface scale");

    fireEvent.change(fontSizeSlider, { target: { value: "1.36" } });
    fireEvent.click(screen.getByTestId("settings-ui-scale-save"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiScale: 1.36 }),
      );
    });

    fireEvent.change(fontSizeSlider, { target: { value: "0.8" } });
    fireEvent.click(screen.getByTestId("settings-ui-scale-save"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiScale: 0.8 }),
      );
    });
  });

  it("resets ui scale to 100% from settings", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { uiScale: 1.25 },
    });

    fireEvent.click(screen.getByTestId("settings-ui-scale-reset"));
    fireEvent.click(screen.getByTestId("settings-ui-scale-save"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiScale: 1 }),
      );
    });
  });

  it("commits ui font selection and code font dropdown changes", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    queryLocalFontsMock.mockResolvedValue([...mockedLocalFonts]);
    renderDisplaySection({ onUpdateAppSettings });

    const uiFontSelect = screen.getByTestId("settings-ui-font-select");
    await waitFor(() => {
      expect(
        within(uiFontSelect).getByRole("option", { name: "Avenir" }),
      ).toBeTruthy();
    });
    fireEvent.change(uiFontSelect, { target: { value: "Avenir" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiFontFamily: "Avenir" }),
      );
    });

    const codeFontSelect = screen.getByTestId("settings-code-font-select");
    fireEvent.change(codeFontSelect, { target: { value: "Avenir" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeFontFamily: "Avenir" }),
      );
    });
  });

  it("lists local fonts in ui/code dropdowns", async () => {
    queryLocalFontsMock.mockResolvedValue([...mockedLocalFonts]);
    renderDisplaySection();

    await waitFor(() => {
      const uiFontSelect = screen.getByTestId("settings-ui-font-select");
      const codeFontSelect = screen.getByTestId("settings-code-font-select");
      expect(
        within(uiFontSelect).getByRole("option", { name: "Avenir" }),
      ).toBeTruthy();
      expect(
        within(uiFontSelect).getByRole("option", { name: "Monaco" }),
      ).toBeTruthy();
      expect(
        within(codeFontSelect).getByRole("option", { name: "Avenir" }),
      ).toBeTruthy();
      expect(
        within(codeFontSelect).getByRole("option", { name: "Monaco" }),
      ).toBeTruthy();
    });
  });

  it("resets font families to defaults", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const uiFontInput = screen.getByLabelText("UI font family");
    const uiFontRow = uiFontInput.closest(".settings-field-row");
    if (!uiFontRow) {
      throw new Error("Expected UI font row");
    }
    fireEvent.click(
      within(uiFontRow as HTMLElement).getByRole("button", { name: "Reset" }),
    );

    const codeFontInput = screen.getByLabelText("Code font family");
    const codeFontRow = codeFontInput.closest(".settings-field-row");
    if (!codeFontRow) {
      throw new Error("Expected code font row");
    }
    fireEvent.click(
      within(codeFontRow as HTMLElement).getByRole("button", { name: "Reset" }),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          uiFontFamily: expect.stringMatching(/^Monaco,/),
        }),
      );
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          codeFontFamily: expect.stringMatching(/^Monaco,/),
        }),
      );
    });
  });

  it("updates code font size from the slider", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const slider = screen.getByLabelText("Code font size");
    fireEvent.change(slider, { target: { value: "14" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeFontSize: 14 }),
      );
    });
  });

  it("toggles notification sounds", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { notificationSoundsEnabled: false },
    });

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));

    const row = screen
      .getByText("Notification sounds")
      .closest(".settings-sound-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected notification sounds row");
    }
    fireEvent.click(within(row).getByRole("switch"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ notificationSoundsEnabled: true }),
      );
    });
  });

  it("updates selected notification sound option", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: {
        notificationSoundsEnabled: true,
        notificationSoundId: "default",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));

    const nativeSelect = screen
      .getAllByLabelText("Notification sound")
      .find((node) => node.tagName.toLowerCase() === "select");
    if (!nativeSelect) {
      throw new Error("Expected native notification sound select");
    }
    fireEvent.change(nativeSelect, {
      target: { value: "bell" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ notificationSoundId: "bell" }),
      );
    });
  });

  it("auto applies network proxy when toggled on", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { systemProxyEnabled: false, systemProxyUrl: null },
    });
    vi.mocked(pushErrorToast).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    const proxyCard = document.querySelector(
      ".settings-basic-proxy-card",
    ) as HTMLElement | null;
    if (!proxyCard) {
      throw new Error("Expected network proxy card");
    }
    fireEvent.change(screen.getByLabelText("settings.behaviorProxyAddress"), {
      target: { value: "http://127.0.0.1:7890" },
    });
    fireEvent.click(within(proxyCard).getByRole("switch"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          systemProxyEnabled: true,
          systemProxyUrl: "http://127.0.0.1:7890",
        }),
      );
    });

    expect(
      document.querySelector(".settings-basic-proxy-card.is-enabled"),
    ).toBeTruthy();
    expect(document.querySelector(".settings-proxy-header-badge")).toBeTruthy();
    expect(
      document.querySelectorAll(
        ".settings-basic-proxy-card .proxy-status-badge",
      ),
    ).toHaveLength(1);
    expect((await screen.findByRole("status")).textContent ?? "").toContain(
      "settings.behaviorProxyEnabledSuccess",
    );
  });

  it("auto disables network proxy when toggled off", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: {
        systemProxyEnabled: true,
        systemProxyUrl: "http://127.0.0.1:7890",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    const proxyCard = document.querySelector(
      ".settings-basic-proxy-card",
    ) as HTMLElement | null;
    if (!proxyCard) {
      throw new Error("Expected network proxy card");
    }

    fireEvent.click(within(proxyCard).getByRole("switch"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          systemProxyEnabled: false,
          systemProxyUrl: "http://127.0.0.1:7890",
        }),
      );
    });

    expect((await screen.findByRole("status")).textContent ?? "").toContain(
      "settings.behaviorProxyDisabledSuccess",
    );
  });

  it("rolls back proxy toggle and shows failure feedback when auto apply fails", async () => {
    const onUpdateAppSettings = vi
      .fn()
      .mockRejectedValue(new Error("proxy apply failed"));
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { systemProxyEnabled: false, systemProxyUrl: null },
    });

    fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
    const proxyCard = document.querySelector(
      ".settings-basic-proxy-card",
    ) as HTMLElement | null;
    if (!proxyCard) {
      throw new Error("Expected network proxy card");
    }

    fireEvent.change(screen.getByLabelText("settings.behaviorProxyAddress"), {
      target: { value: "http://127.0.0.1:7890" },
    });
    fireEvent.click(within(proxyCard).getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent ?? "").toContain(
        "proxy apply failed",
      );
    });

    expect(
      within(proxyCard).getByRole("switch").getAttribute("aria-checked"),
    ).toBe("false");
    expect(pushErrorToast).toHaveBeenCalledWith({
      title: "common.error",
      message: "proxy apply failed",
    });
  });
});

describe("SettingsView Composer", () => {
  it("updates send shortcut mode", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderComposerSection({ onUpdateAppSettings });

    fireEvent.click(
      screen.getByRole("radio", { name: /⌘\/Ctrl\+Enter sends/i }),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ composerSendShortcut: "cmdEnter" }),
      );
    });
  });
});

describe("SettingsView Session management", () => {
  it("opens session management on the active workspace instead of the first project", async () => {
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      data: [],
      nextCursor: null,
      partialSource: null,
    });

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          { id: null, name: "Ungrouped", workspaces: [workspaceA, workspaceB] },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspaceB}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="project-management"
        initialHighlightTarget="project-sessions"
      />,
    );

    await waitFor(() => {
      expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-b", {
        query: {
          keyword: null,
          engine: null,
          status: "active",
          folderId: null,
          sessionAttributionMode: "related",
        },
        cursor: null,
        limit: 100,
      });
    });
  });

  it("loads session catalog entries for the active workspace", async () => {
    const workspace: WorkspaceInfo = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/workspace",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      data: [
        {
          sessionId: "codex:thread-a",
          workspaceId: "ws-1",
          title: "Session A",
          updatedAt: 1710000000000,
          engine: "codex",
          archivedAt: null,
          threadKind: "native",
          sourceLabel: "cli/codex",
        },
      ],
      nextCursor: null,
      partialSource: null,
    });

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          { id: null, name: "Ungrouped", workspaces: [workspace] },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspace}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="project-management"
        initialHighlightTarget="project-sessions"
      />,
    );

    await waitFor(() => {
      expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-1", {
        query: {
          keyword: null,
          engine: null,
          status: "active",
          folderId: null,
          sessionAttributionMode: "related",
        },
        cursor: null,
        limit: 100,
      });
    });
    expect(await screen.findByText("Session A")).toBeTruthy();
  });

  it("deletes selected sessions and triggers workspace refresh", async () => {
    const workspace: WorkspaceInfo = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/workspace",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    const onEnsureWorkspaceThreads = vi.fn();

    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      data: [
        {
          sessionId: "codex:thread-a",
          workspaceId: "ws-1",
          title: "Session A",
          updatedAt: 1710000000000,
          engine: "codex",
          archivedAt: null,
          threadKind: "native",
          sourceLabel: "cli/codex",
        },
      ],
      nextCursor: null,
      partialSource: null,
    });
    vi.mocked(deleteWorkspaceSessions).mockResolvedValue({
      results: [{ sessionId: "codex:thread-a", ok: true }],
    });

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          { id: null, name: "Ungrouped", workspaces: [workspace] },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspace}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        onEnsureWorkspaceThreads={onEnsureWorkspaceThreads}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="project-management"
        initialHighlightTarget="project-sessions"
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: "Session A" });
    fireEvent.click(checkbox);

    const deleteButton = screen.getByTestId(
      "settings-project-sessions-delete-selected",
    );
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(deleteWorkspaceSessions).toHaveBeenCalledWith("ws-1", [
        "codex:thread-a",
      ]);
    });
    await waitFor(() => {
      expect(onEnsureWorkspaceThreads).toHaveBeenCalledWith("ws-1", {
        deletedThreadIds: ["codex:thread-a"],
      });
    });
  });

  it("toggles the session management section body", async () => {
    const workspace: WorkspaceInfo = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/workspace",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      data: [
        {
          sessionId: "codex:thread-a",
          workspaceId: "ws-1",
          title: "Session A",
          updatedAt: 1710000000000,
          engine: "codex",
          archivedAt: null,
          threadKind: "native",
          sourceLabel: "cli/codex",
        },
      ],
      nextCursor: null,
      partialSource: null,
    });

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          { id: null, name: "Ungrouped", workspaces: [workspace] },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={workspace}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="project-management"
        initialHighlightTarget="project-sessions"
      />,
    );

    expect(await screen.findByText("Session A")).toBeTruthy();

    const toggleButton = screen.getByTestId(
      "settings-project-sessions-expand-toggle",
    );
    fireEvent.click(toggleButton);
    expect(screen.queryByText("Session A")).toBeNull();

    fireEvent.click(toggleButton);
    expect(await screen.findByText("Session A")).toBeTruthy();
  });
});

describe("SettingsView Shortcuts", () => {
  function expectTabButtonHasIcon(name: string) {
    const tabButton = screen.getByRole("button", { name });
    expect(tabButton.querySelector(".settings-basic-tab-icon")).toBeTruthy();
  }

  it("reaches shortcuts and open-app editors from Basic tabs", async () => {
    renderDisplaySection();
    await flushSettingsViewEffects();

    expectTabButtonHasIcon("Appearance");
    expectTabButtonHasIcon("Behavior");
    expectTabButtonHasIcon("Shortcuts");
    expectTabButtonHasIcon("Open in");
    expectTabButtonHasIcon("Web Service");
    expectTabButtonHasIcon("Email");

    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    await flushSettingsViewEffects();
    expect(screen.getAllByText("Shortcuts").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(
        "Customize keyboard shortcuts for file actions, composer, panels, and navigation.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    await flushSettingsViewEffects();
    expect(screen.getAllByText("Open in").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByDisplayValue("VS Code")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Web Service" }));
    await flushSettingsViewEffects();
    expect(screen.getAllByText("Web Service").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByLabelText("settings.webServicePortAriaLabel"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    await flushSettingsViewEffects();
    expect(screen.getAllByText("Email").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("switch", { name: "settings.emailEnableTitle" }),
    ).toBeTruthy();
  });

  it("reaches all consolidated parent tabs", async () => {
    renderDisplaySection();
    await flushSettingsViewEffects();

    fireEvent.click(screen.getByRole("button", { name: "Project Management" }));
    await flushSettingsViewEffects();
    expect(screen.getByRole("button", { name: "Groups" })).toBeTruthy();
    expectTabButtonHasIcon("Groups");
    expectTabButtonHasIcon("Session Management");
    expect(screen.queryByRole("button", { name: "Usage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Session Management" }));
    await flushSettingsViewEffects();
    expect(
      screen.getByTestId("settings-project-sessions-expand-toggle"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Agents / Prompts" }));
    await flushSettingsViewEffects();
    expect(screen.getByRole("button", { name: "Agents" })).toBeTruthy();
    expectTabButtonHasIcon("Agents");
    expectTabButtonHasIcon("Prompts");
    fireEvent.click(screen.getByRole("button", { name: "Prompts" }));
    await flushSettingsViewEffects();
    expect(screen.getByText("settings.prompt.title")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "MCP / Skills" }));
    await flushSettingsViewEffects();
    expect(screen.getByRole("button", { name: "MCP Servers" })).toBeTruthy();
    expectTabButtonHasIcon("MCP Servers");
    expectTabButtonHasIcon("Skills");
    expect(screen.getByTestId("embedded-mcp-section")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    await flushSettingsViewEffects();
    expect(screen.getByTestId("embedded-skills-section")).toBeTruthy();
    expect(skillsSectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        embedded: true,
        appSettings: expect.objectContaining({
          customSkillDirectories: [],
        }),
        onUpdateAppSettings: expect.any(Function),
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Runtime Environment" }),
    );
    await flushSettingsViewEffects();
    expect(screen.getByRole("button", { name: "Runtime Pool" })).toBeTruthy();
    expectTabButtonHasIcon("Runtime Pool");
    expectTabButtonHasIcon("CLI Validation");
    fireEvent.click(screen.getByRole("button", { name: "CLI Validation" }));
    await flushSettingsViewEffects();
    expect(screen.getAllByText("CLI Validation").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("closes when clicking back to app", async () => {
    const onClose = vi.fn();
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("closes on Cmd+W", async () => {
    let unmount = () => {};
    const onClose = vi.fn(() => {
      unmount();
    });
    const rendered = render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );
    unmount = rendered.unmount;

    fireEvent.keyDown(window, { key: "w", metaKey: true, bubbles: true });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes on Escape", async () => {
    let unmount = () => {};
    const onClose = vi.fn(() => {
      unmount();
    });
    const rendered = render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        activeWorkspace={null}
        activeEngine="codex"
        onUpdateWorkspaceCodexBin={vi.fn().mockResolvedValue(undefined)}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );
    unmount = rendered.unmount;

    fireEvent.keyDown(window, { key: "Escape", bubbles: true });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
