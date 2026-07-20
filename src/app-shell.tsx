import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useThreads } from "./features/threads/hooks/useThreads";
import { useGitPanelController } from "./features/app/hooks/useGitPanelController";
import { useGitRemote } from "./features/git/hooks/useGitRemote";
import { useGitRepoScan } from "./features/git/hooks/useGitRepoScan";
import { useAutoExitEmptyDiff } from "./features/git/hooks/useAutoExitEmptyDiff";
import { useModels } from "./features/models/hooks/useModels";
import { useCollaborationModes } from "./features/collaboration/hooks/useCollaborationModes";
import { useSkills } from "./features/skills/hooks/useSkills";
import { useCustomCommands } from "./features/commands/hooks/useCustomCommands";
import { useCustomPrompts } from "./features/prompts/hooks/useCustomPrompts";
import { useWorkspaceFiles } from "./features/workspaces/hooks/useWorkspaceFiles";
import { useDebugLog } from "./features/debug/hooks/useDebugLog";
import { useWorkspaceRefreshOnFocus } from "./features/workspaces/hooks/useWorkspaceRefreshOnFocus";
import { useWorkspaceRestore } from "./features/workspaces/hooks/useWorkspaceRestore";
import { useLayoutController } from "./features/app/hooks/useLayoutController";
import { useAppSettingsController } from "./features/app/hooks/useAppSettingsController";
import { useUpdaterController } from "./features/app/hooks/useUpdaterController";
import { useReleaseNotes } from "./features/update/hooks/useReleaseNotes";
import { useErrorToasts } from "./features/notifications/hooks/useErrorToasts";
import { useComposerEditorState } from "./features/composer/hooks/useComposerEditorState";
import { useDictationController } from "./features/app/hooks/useDictationController";
import { useComposerController } from "./features/app/hooks/useComposerController";
import { useEngineController } from "./features/engine/hooks/useEngineController";
import { useRenameThreadPrompt } from "./features/threads/hooks/useRenameThreadPrompt";
import { useDeleteThreadPrompt } from "./features/threads/hooks/useDeleteThreadPrompt";
import { useWorktreePrompt } from "./features/workspaces/hooks/useWorktreePrompt";
import { useWorkspaceController } from "./features/app/hooks/useWorkspaceController";
import { useWorkspaceSelection } from "./features/workspaces/hooks/useWorkspaceSelection";
import { useGitHubPanelController } from "./features/app/hooks/useGitHubPanelController";
import { useSettingsModalState } from "./features/app/hooks/useSettingsModalState";
import { useLoadingProgressDialogState } from "./features/app/hooks/useLoadingProgressDialogState";
import { useSyncSelectedDiffPath } from "./features/app/hooks/useSyncSelectedDiffPath";
import { useWorkspaceActions } from "./features/app/hooks/useWorkspaceActions";
import { useThreadRows } from "./features/app/hooks/useThreadRows";
import { useLiquidGlassEffect } from "./features/app/hooks/useLiquidGlassEffect";
import { useCopyThread } from "./features/threads/hooks/useCopyThread";
import { useKanbanStore } from "./features/kanban/hooks/useKanbanStore";
import { useGitCommitController } from "./features/app/hooks/useGitCommitController";
import { useMultiRepositoryGitStatus } from "./features/git/hooks/useMultiRepositoryGitStatus";
import { stageGitAll, stageGitFile, unstageGitFile } from "./services/tauri";
import { forceRefreshAgents } from "./features/composer/components/ChatInputBox/providers";
import { normalizeFsPath } from "./utils/workspacePaths";
import type {
  AppMode,
  ComposerEditorSettings,
} from "./types";
import { resolveEngineDefaultComposerSelection } from "./app-shell-parts/selectedComposerSession";
import { useCodeCssVars } from "./features/app/hooks/useCodeCssVars";
import { useAccountSwitching } from "./features/app/hooks/useAccountSwitching";
import { extractPlanFromTimelineItems } from "./app-shell-parts/utils";
import { useAppShellPromptActionsSection } from "./app-shell-parts/useAppShellPromptActionsSection";
import { useAppShellSearchRadarSection } from "./app-shell-parts/useAppShellSearchRadarSection";
import { useAppShellSearchAndComposerSection } from "./app-shell-parts/useAppShellSearchAndComposerSection";
import { useAppShellSections } from "./app-shell-parts/useAppShellSections";
import { useAppShellLayoutNodesSection } from "./app-shell-parts/useAppShellLayoutNodesSection";
import { renderAppShell } from "./app-shell-parts/renderAppShell";
import { useOpenCodeSelection } from "./app-shell-parts/useOpenCodeSelection";
import { useOpenCodeThreadBinding } from "./app-shell-parts/useOpenCodeThreadBinding";
import { useGitStatusRefreshOnTurnSettle } from "./app-shell-parts/useGitStatusRefreshOnTurnSettle";
import { useAppShellGitWorkspaceOpsSection } from "./app-shell-parts/useAppShellGitWorkspaceOpsSection";
import { useSelectedAgentSession } from "./app-shell-parts/useSelectedAgentSession";
import { useSelectedComposerSession } from "./app-shell-parts/useSelectedComposerSession";
import { APP_SHELL_LEGACY_CONTEXT_DEFAULTS } from "./app-shell-parts/legacyContextDefaults";
import { usePanelLockState } from "./app-shell-parts/usePanelLockState";
import { usePlanApplyHandlers } from "./app-shell-parts/usePlanApplyHandlers";
import { useThreadScopedCollaborationMode } from "./app-shell-parts/useThreadScopedCollaborationMode";
import { GitHubPanelData, SettingsView } from "./app-shell-parts/lazyViews";
import { useCreateSessionLoading } from "./app-shell-parts/useCreateSessionLoading";
import type { AgentTaskScrollRequest } from "./features/messages/types";
import { useAppShellWorkspaceFlowsSection } from "./app-shell-parts/useAppShellWorkspaceFlowsSection";
import { defineRuntimeThreadShellBoundary } from "./app-shell-parts/runtimeThreadBoundary";
import { useAppShellWorkspaceHomeState } from "./app-shell-parts/useAppShellWorkspaceHomeState";
import { useModelConfigRefresh } from "./app-shell-parts/useModelConfigRefresh";
import { useWorkspacePathsIntake } from "./app-shell-parts/useWorkspacePathsIntake";
import { useAppShellWorktreeChromeSection } from "./app-shell-parts/useAppShellWorktreeChromeSection";
import { useCollaborationModeThreadSync } from "./app-shell-parts/useCollaborationModeThreadSync";
import { useClaudeModelRefreshOnNewThread } from "./app-shell-parts/useClaudeModelRefreshOnNewThread";
import { useAppShellComposerModelSection } from "./app-shell-parts/useAppShellComposerModelSection";
import { useAppShellViewStateSection } from "./app-shell-parts/useAppShellViewStateSection";
import { defineAppShellRuntimeActions } from "./app-shell-parts/appShellActionBoundaries";
import {
  defineAppShellDomainContexts,
  reuseStableAppShellDomainContexts,
  type AppShellDomainContexts,
} from "./app-shell-parts/appShellDomainContexts";
import { useAppShellComposerPrefsPersistence } from "./app-shell-parts/useAppShellComposerPrefsPersistence";
import { useAppShellAccessModeSection } from "./app-shell-parts/useAppShellAccessModeSection";
import { useAppShellDesktopChrome } from "./app-shell-parts/useAppShellDesktopChrome";
import { useAppShellModelSettingsAction } from "./app-shell-parts/useAppShellModelSettingsAction";
import { useAppShellEditorLayoutSection } from "./app-shell-parts/useAppShellEditorLayoutSection";
import { useAppShellSearchPaletteSection } from "./app-shell-parts/useAppShellSearchPaletteSection";
import { useAppShellClaudeThinkingSection } from "./app-shell-parts/useAppShellClaudeThinkingSection";
import {
  buildLatestAgentRuns,
  resolveLatestAgentFeedLoading,
} from "./app-shell-parts/latestAgentRuns";

export function AppShell() {
  const { t } = useTranslation();
  const {
    claudeThinkingVisible,
    handleResolvedClaudeThinkingVisibleChange,
  } = useAppShellClaudeThinkingSection();

  const {
    appSettings,
    setAppSettings,
    doctor,
    claudeDoctor,
    appSettingsLoading,
    reduceTransparency,
    setReduceTransparency,
    windowTransparencyEnabled,
    setWindowTransparencyEnabled,
    windowOpacity,
    setWindowOpacity,
    scaleShortcutTitle,
    scaleShortcutText,
    queueSaveSettings,
  } = useAppSettingsController();
  useCodeCssVars(appSettings);
  const {
    activeEngineRef,
    persistClaudeCollaborationMode,
    persistComposerEnginePref,
  } = useAppShellComposerPrefsPersistence({
    appSettings,
    appSettingsLoading,
  });
  const {
    dictationModel,
    dictationState,
    dictationLevel,
    dictationTranscript,
    dictationError,
    dictationHint,
    dictationReady,
    handleToggleDictation,
    clearDictationTranscript,
    clearDictationError,
    clearDictationHint,
  } = useDictationController(appSettings);
  const {
    debugOpen,
    setDebugOpen,
    debugEntries,
    showDebugButton,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
  } = useDebugLog();
  useLiquidGlassEffect({
    reduceTransparency,
    onDebug: addDebugEntry,
  });
  const [activeTab, setActiveTab] = useState<
    "projects" | "codex" | "spec" | "git" | "log"
  >("codex");
  const tabletTab = activeTab === "projects" ? "codex" : activeTab;
  const {
    workspaces,
    workspaceGroups,
    groupedWorkspaces,
    getWorkspaceGroupName,
    ungroupedLabel,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    addWorkspaceFromPath,
    addCloneAgent,
    addWorktreeAgent,
    connectWorkspace,
    markWorkspaceConnected,
    updateWorkspaceSettings,
    updateWorkspaceCodexBin,
    createWorkspaceGroup,
    renameWorkspaceGroup,
    moveWorkspaceGroup,
    deleteWorkspaceGroup,
    assignWorkspaceGroup,
    removeWorkspace,
    removeWorktree,
    renameWorktree,
    renameWorktreeUpstream,
    deletingWorktreeIds,
    hasLoaded,
    refreshWorkspaces,
  } = useWorkspaceController({
    appSettings,
    addDebugEntry,
    queueSaveSettings,
  });
  const {
    homeOpen,
    homeWorkspaceDefaultId,
    homeWorkspaceSelectedId,
    setHomeOpen,
    workspacesById,
    workspacesByPath,
  } = useAppShellWorkspaceHomeState({
    activeWorkspaceId,
    appSettingsLoading,
    groupedWorkspaces,
    hasLoaded,
    workspaces,
  });
  const {
    sidebarWidth,
    rightPanelWidth,
    setRightPanelWidth,
    onSidebarResizeStart,
    onRightPanelResizeStart,
    planPanelHeight,
    onPlanPanelResizeStart,
    terminalPanelHeight,
    onTerminalPanelResizeStart,
    debugPanelHeight,
    onDebugPanelResizeStart,
    kanbanConversationWidth,
    onKanbanConversationResizeStart,
    isCompact,
    isTablet,
    isPhone,
    sidebarCollapsed,
    rightPanelCollapsed,
    collapseSidebar,
    expandSidebar,
    collapseRightPanel,
    expandRightPanel,
    terminalOpen,
    handleDebugClick,
    handleToggleTerminal,
    openTerminal,
    closeTerminal: closeTerminalPanel,
  } = useLayoutController({
    activeWorkspaceId,
    setActiveTab,
    setDebugOpen,
    toggleDebugPanelShortcut: appSettings.toggleDebugPanelShortcut,
    toggleTerminalShortcut: appSettings.toggleTerminalShortcut,
  });
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [agentTaskScrollRequest, setAgentTaskScrollRequest] =
    useState<AgentTaskScrollRequest | null>(null);
  const {
    activeEditorLineRange,
    appRootRef,
    editorSplitLayout,
    fileReferenceMode,
    gitHistoryPanelHeight,
    gitHistoryPanelHeightRef,
    isEditorFileMaximized,
    liveEditPreviewEnabled,
    onGitHistoryPanelResizeStart,
    requestEditorOpenLayout,
    resetSoloSplitToHalf,
    setActiveEditorLineRange,
    setEditorSplitLayout,
    setFileReferenceMode,
    setGitHistoryPanelHeight,
    setIsEditorFileMaximized,
    setLiveEditPreviewEnabled,
  } = useAppShellEditorLayoutSection({
    collapseSidebar,
    setAppMode,
    setRightPanelWidth,
  });

  const {
    settingsOpen,
    settingsSection,
    settingsHighlightTarget,
    openSettings,
    closeSettings,
  } = useSettingsModalState();
  const {
    loadingProgressDialog,
    showLoadingProgressDialog,
    hideLoadingProgressDialog,
    dismissLoadingProgressDialog,
  } = useLoadingProgressDialogState();

  const runWithCreateSessionLoading = useCreateSessionLoading({
    hideLoadingProgressDialog,
    showLoadingProgressDialog,
    t,
  });

  const handleOpenModelSettings = useAppShellModelSettingsAction(openSettings);

  const {
    globalSearchFilesByWorkspace, isSearchPaletteOpen, searchContentFilters,
    searchPaletteQuery, searchPaletteSelectedIndex, searchScope,
    setGlobalSearchFilesByWorkspace, setIsSearchPaletteOpen,
    setSearchContentFilters, setSearchPaletteQuery, setSearchPaletteSelectedIndex,
    setSearchScope,
  } = useAppShellSearchPaletteSection();
  const {
    isPanelLocked,
    setIsPanelLocked,
    handleLockPanel,
    handleUnlockPanel,
  } = usePanelLockState();
  const completionTrackerReadyRef = useRef(false);
  const completionTrackerBySessionRef = useRef<Record<string, any>>({});
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  const {
    updaterState,
    startUpdate,
    dismissUpdate,
    handleTestNotificationSound,
  } = useUpdaterController({
    notificationSoundsEnabled: appSettings.notificationSoundsEnabled,
    notificationSoundId: appSettings.notificationSoundId,
    notificationSoundCustomPath: appSettings.notificationSoundCustomPath,
    onDebug: addDebugEntry,
  });
  const {
    isOpen: releaseNotesOpen,
    entries: releaseNotesEntries,
    activeIndex: releaseNotesActiveIndex,
    loading: releaseNotesLoading,
    error: releaseNotesError,
    openReleaseNotes,
    closeReleaseNotes,
    goToPrevious: showPreviousReleaseNotes,
    goToNext: showNextReleaseNotes,
    retryLoad: retryReleaseNotesLoad,
  } = useReleaseNotes({
    onDebug: addDebugEntry,
  });

  const { errorToasts, dismissErrorToast } = useErrorToasts();
  const normalizePath = useCallback(
    (path: string) => normalizeFsPath(path).trim(),
    [],
  );

  const {
    gitIssues,
    gitIssuesTotal,
    gitIssuesLoading,
    gitIssuesError,
    gitPullRequests,
    gitPullRequestsTotal,
    gitPullRequestsLoading,
    gitPullRequestsError,
    gitPullRequestDiffs,
    gitPullRequestDiffsLoading,
    gitPullRequestDiffsError,
    gitPullRequestComments,
    gitPullRequestCommentsLoading,
    gitPullRequestCommentsError,
    handleGitIssuesChange,
    handleGitPullRequestsChange,
    handleGitPullRequestDiffsChange,
    handleGitPullRequestCommentsChange,
    resetGitHubPanelState,
  } = useGitHubPanelController();

  const {
    centerMode,
    setCenterMode,
    selectedDiffPath,
    setSelectedDiffPath,
    diffScrollRequestId,
    gitPanelMode,
    setGitPanelMode,
    gitDiffViewStyle,
    setGitDiffViewStyle,
    gitDiffListView,
    setGitDiffListView,
    filePanelMode,
    setFilePanelMode,
    selectedPullRequest,
    setSelectedPullRequest,
    selectedCommitSha,
    setSelectedCommitSha,
    diffSource,
    setDiffSource,
    gitStatus,
    refreshGitStatus,
    queueGitStatusRefresh,
    refreshGitDiffs,
    gitLogEntries,
    gitLogTotal,
    gitLogAhead,
    gitLogBehind,
    gitLogAheadEntries,
    gitLogBehindEntries,
    gitLogUpstream,
    gitLogLoading,
    gitLogError,
    refreshGitLog,
    gitCommitDiffs,
    shouldLoadDiffs,
    activeDiffs,
    activeDiffLoading,
    activeDiffError,
    handleSelectDiff,
    handleSelectCommit,
    handleActiveDiffPath,
    handleGitPanelModeChange,
    activeEditorFilePath,
    editorSplitCompanion,
    setEditorSplitCompanion,
    editorNavigationTarget,
    editorHighlightTarget,
    fileCompareSession,
    openFileTabs,
    handleOpenFile,
    handleOpenWorkspaceFileCompare,
    handleOpenScratchFileCompare,
    handleCloseFileCompare,
    handleActivateFileTab,
    handleCloseFileTab,
    handleCloseAllFileTabs,
    handleReorderFileTabs,
    handleExitEditor,
    activeWorkspaceIdRef,
    activeWorkspaceRef,
  } = useGitPanelController({
    activeWorkspace,
    gitDiffPreloadEnabled: appSettings.preloadGitDiffs,
    isCompact,
    isTablet,
    rightPanelCollapsed,
    activeTab,
    tabletTab,
    setActiveTab,
    prDiffs: gitPullRequestDiffs,
    prDiffsLoading: gitPullRequestDiffsLoading,
    prDiffsError: gitPullRequestDiffsError,
    onOpenEditorLayoutRequest: requestEditorOpenLayout,
  });

  useEffect(() => {
    if (!activeEditorFilePath) {
      setActiveEditorLineRange(null);
      setIsEditorFileMaximized(false);
    }
  }, [
    activeEditorFilePath,
    setActiveEditorLineRange,
    setIsEditorFileMaximized,
  ]);

  const shouldLoadGitHubPanelData =
    gitPanelMode === "issues" ||
    gitPanelMode === "prs" ||
    (shouldLoadDiffs && diffSource === "pr");

  useEffect(() => {
    resetGitHubPanelState();
  }, [activeWorkspaceId, resetGitHubPanelState]);
  const { remote: gitRemoteUrl } = useGitRemote(activeWorkspace);
  const {
    repos: gitRootCandidates,
    isLoading: gitRootScanLoading,
    error: gitRootScanError,
    depth: gitRootScanDepth,
    hasScanned: gitRootScanHasScanned,
    scan: scanGitRoots,
    setDepth: setGitRootScanDepth,
    clear: clearGitRootCandidates,
  } = useGitRepoScan(activeWorkspace);
  const {
    models,
    modelsReady,
    selectedModelId,
    setSelectedModelId,
    selectedEffort,
    setSelectedEffort,
    refreshModels,
    globalSelectionReady,
  } = useModels({
    activeWorkspace,
    onDebug: addDebugEntry,
    preferredModelId: appSettings.lastComposerModelId,
    preferredEffort: appSettings.lastComposerReasoningEffort,
    preferredSelectionReady: !appSettingsLoading,
  });

  const {
    collaborationModes,
    collaborationModesEnabled,
    selectedCollaborationMode,
    selectedCollaborationModeId,
    setSelectedCollaborationModeId,
  } = useCollaborationModes({
    activeWorkspace,
    enabled: true,
    onDebug: addDebugEntry,
  });
  const {
    collaborationUiModeByThread,
    setCollaborationUiModeByThread,
    collaborationRuntimeModeByThread,
    setCollaborationRuntimeModeByThread,
    activeThreadIdForModeRef,
    lastCodexModeSyncThreadRef,
    codexComposerModeRef,
    applySelectedCollaborationMode,
    setCodexCollaborationMode,
    resolveCollaborationRuntimeMode,
    resolveCollaborationUiMode,
    handleCollaborationModeResolved,
  } = useThreadScopedCollaborationMode({
    setSelectedCollaborationModeId,
    onExplicitCollaborationModeChange: persistClaudeCollaborationMode,
  });

  const { skills } = useSkills({
    activeWorkspace,
    customSkillDirectories: appSettings.customSkillDirectories,
    onDebug: addDebugEntry,
  });
  const {
    activeEngine,
    availableEngines,
    installedEngines,
    setActiveEngine,
    engineModelsAsOptions,
    engineModelCatalogsAsOptions,
    engineStatuses,
    refreshEngineModels,
    refreshEngines,
  } = useEngineController({
    activeWorkspace,
    enabledEngines: {
      gemini: appSettings.geminiEnabled !== false,
      opencode: appSettings.opencodeEnabled !== false,
    },
    onDebug: addDebugEntry,
  });
  activeEngineRef.current = activeEngine;
  const {
    accessMode,
    claudeAccessModeRef,
    handleSetAccessMode,
    setAccessMode,
  } = useAppShellAccessModeSection({
    activeEngine,
    appSettingsLoading,
    defaultAccessMode: appSettings.defaultAccessMode,
    persistComposerEnginePref,
  });
  const { handleRefreshModelConfig, isModelConfigRefreshing } =
    useModelConfigRefresh({
      activeEngine,
      addDebugEntry,
      refreshEngineModels,
      refreshModels,
    });
  const {
    openCodeAgents,
    resolveOpenCodeAgentForThread,
    resolveOpenCodeVariantForThread,
    selectOpenCodeAgentForThread,
    selectOpenCodeVariantForThread,
    syncActiveOpenCodeThread,
  } = useOpenCodeSelection({
    activeEngine,
    enabled: appSettings.opencodeEnabled !== false,
    activeWorkspaceId,
    onDebug: addDebugEntry,
  });

  const handleAppModeChange = useCallback(
    (mode: AppMode) => {
      setAppMode(mode);
      closeSettings();
    },
    [closeSettings],
  );
  const {
    panels: kanbanPanels,
    tasks: kanbanTasks,
    kanbanViewState,
    setKanbanViewState,
    createPanel: kanbanCreatePanel,
    updatePanel: kanbanUpdatePanel,
    deletePanel: kanbanDeletePanel,
    createTask: kanbanCreateTask,
    updateTask: kanbanUpdateTask,
    deleteTask: kanbanDeleteTask,
    reorderTask: kanbanReorderTask,
  } = useKanbanStore(workspaces);

  const {
    prompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
    movePrompt,
    getWorkspacePromptsDir,
    getGlobalPromptsDir,
  } = useCustomPrompts({ activeWorkspace, onDebug: addDebugEntry });
  const { commands } = useCustomCommands({
    onDebug: addDebugEntry,
    activeEngine,
    workspaceId: activeWorkspace?.id ?? null,
  });
  const workspaceFilesInitialLoadEnabled = Boolean(activeWorkspace?.id);
  const workspaceFilesPollingEnabled =
    !isCompact && !rightPanelCollapsed && filePanelMode === "files";
  const {
    files,
    directories,
    directoryMetadata,
    sourceVersion: fileTreeSourceVersion,
    gitignoredFiles,
    gitignoredDirectories,
    isLoading: isFilesLoading,
    loadError: fileTreeLoadError,
    refreshFiles,
  } = useWorkspaceFiles({
    activeWorkspace,
    onDebug: addDebugEntry,
    initialLoadEnabled: workspaceFilesInitialLoadEnabled,
    pollingEnabled: workspaceFilesPollingEnabled,
  });
  const {
    activeGitRoot,
    alertError,
    branches,
    branchError,
    currentBranch,
    localBranches,
    remoteBranches,
    repositories,
    repositoriesLoading,
    repositoryError,
    refreshRepositories,
    selectedRepositoryRoot,
    selectRepository,
    checkoutBranch,
    createBranch,
    fileStatus,
    handleApplyWorktreeChanges,
    handleCheckoutBranch,
    handleCreateBranch,
    handleUpdateBranch,
    handleOpenDetachedFileExplorer,
    handlePickGitRoot,
    handleRevertAllGitChanges,
    handleRevertGitFile,
    handleSetGitRoot,
    handleStageGitAll,
    handleStageGitFile,
    handleUnstageGitFile,
    worktreeApplyError,
    worktreeApplyLoading,
    worktreeApplySuccess,
  } = useAppShellGitWorkspaceOpsSection({
    activeWorkspace,
    addDebugEntry,
    clearGitRootCandidates,
    gitStatus,
    refreshGitDiffs,
    refreshGitStatus,
    t,
    updateWorkspaceSettings,
  });

  const { textareaHeight, onTextareaHeightChange } = useComposerEditorState();

  const composerEditorSettings = useMemo<ComposerEditorSettings>(
    () => ({
      preset: appSettings.composerEditorPreset,
      expandFenceOnSpace: appSettings.composerFenceExpandOnSpace,
      expandFenceOnEnter: appSettings.composerFenceExpandOnEnter,
      fenceLanguageTags: appSettings.composerFenceLanguageTags,
      fenceWrapSelection: appSettings.composerFenceWrapSelection,
      autoWrapPasteMultiline: appSettings.composerFenceAutoWrapPasteMultiline,
      autoWrapPasteCodeLike: appSettings.composerFenceAutoWrapPasteCodeLike,
      continueListOnShiftEnter: appSettings.composerListContinuation,
    }),
    [
      appSettings.composerEditorPreset,
      appSettings.composerFenceExpandOnSpace,
      appSettings.composerFenceExpandOnEnter,
      appSettings.composerFenceLanguageTags,
      appSettings.composerFenceWrapSelection,
      appSettings.composerFenceAutoWrapPasteMultiline,
      appSettings.composerFenceAutoWrapPasteCodeLike,
      appSettings.composerListContinuation,
    ],
  );

  useSyncSelectedDiffPath({
    diffSource,
    centerMode,
    gitPullRequestDiffs,
    gitCommitDiffs,
    selectedDiffPath,
    setSelectedDiffPath,
  });
  const composerSelectionResolverRef = useRef({
    id: null as string | null,
    model: null as string | null,
    source: null as string | null,
    providerProfileId: null as string | null,
    effort: null as string | null,
    collaborationMode: null as Record<string, unknown> | null,
  });
  const resolveComposerSelection = useCallback(
    () => composerSelectionResolverRef.current,
    [],
  );

  const {
    setActiveThreadId,
    activeThreadId,
    activeItems,
    threadItemsByThread,
    historyRestoredAtMsByThread,
    approvals,
    userInputRequests,
    threadsByWorkspace,
    threadParentById,
    threadStatusById,
    historyLoadingByThreadId,
    activeTurnIdByThread,
    completionEmailIntentByThread,
    toggleCompletionEmailIntent,
    threadListLoadingByWorkspace,
    threadListPagingByWorkspace,
    threadListCursorByWorkspace,
    tokenUsageByThread,
    rateLimitsByWorkspace,
    accountByWorkspace,
    planByThread,
    lastAgentMessageByThread,
    interruptTurn,
    removeThread,
    removeThreads,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
    pinnedThreadsVersion,
    renameThread,
    triggerAutoThreadTitle,
    isThreadAutoNaming,
    startThreadForWorkspace,
    forkThreadForWorkspace,
    forkSessionFromMessageForWorkspace,
    forkClaudeSessionFromMessageForWorkspace,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    resetWorkspaceThreads,
    refreshThread,
    sendUserMessage,
    sendUserMessageToThread,
    handleFusionStalled,
    startFork,
    startReview,
    startResume,
    startMcp,
    startSpecRoot,
    startStatus,
    startContext,
    startCompact,
    startFast,
    startMode,
    startExport,
    startImport,
    startLsp,
    startShare,
    startSharedSessionForWorkspace,
    updateSharedSessionEngineSelection,
    updateThreadParent,
    resolveCanonicalThreadId,
    reviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
    handleApprovalBatchAccept,
    handleApprovalDecision,
    handleApprovalRemember,
    handleUserInputSubmit,
    refreshAccountInfo,
    refreshAccountRateLimits,
  } = useThreads({
    activeWorkspace,
    onWorkspaceConnected: markWorkspaceConnected,
    onWorkspaceModelsRefresh: refreshModels,
    onDebug: addDebugEntry,
    model: null,
    effort: null,
    collaborationMode: null,
    resolveComposerSelection,
    claudeThinkingVisible,
    accessMode,
    steerEnabled: appSettings.experimentalSteerEnabled,
    customPrompts: prompts,
    activeEngine,
    useNormalizedRealtimeAdapters: appSettings.chatCanvasUseNormalizedRealtime,
    useUnifiedHistoryLoader: appSettings.chatCanvasUseUnifiedHistoryLoader,
    sessionAttributionMode: appSettings.sessionAttributionMode,
    resolveOpenCodeAgent: resolveOpenCodeAgentForThread,
    resolveOpenCodeVariant: resolveOpenCodeVariantForThread,
    resolveCollaborationUiMode,
    resolveCollaborationRuntimeMode,
    onCollaborationModeResolved: handleCollaborationModeResolved,
    runWithCreateSessionLoading,
  });

  const {
    handleSelectOpenCodeAgent,
    handleSelectOpenCodeVariant,
    selectedOpenCodeAgent,
    selectedOpenCodeVariant,
  } = useOpenCodeThreadBinding({
    activeThreadId,
    resolveOpenCodeAgentForThread,
    resolveOpenCodeVariantForThread,
    selectOpenCodeAgentForThread,
    selectOpenCodeVariantForThread,
    syncActiveOpenCodeThread,
  });

  useGitStatusRefreshOnTurnSettle({
    queueGitStatusRefresh,
    threadStatusById,
  });
  const {
    selectedComposerSelection,
    handleSelectComposerSelection,
    persistComposerSelectionForThread,
    resolveComposerSelectionForThread,
  } = useSelectedComposerSession({
    activeThreadId,
    activeWorkspaceId,
    resolveCanonicalThreadId,
    engineDefaultSelectionReady: !appSettingsLoading,
    resolveEngineDefaultComposerSelection,
    onDebug: addDebugEntry,
  });
  const {
    collaborationModePayload,
    effectiveModels,
    effectiveReasoningOptions,
    effectiveReasoningSupported,
    effectiveSelectedEffort,
    effectiveSelectedModel,
    effectiveSelectedModelId,
    engineSelectedModelIdByType,
    handleSelectComposerEffort,
    handleSelectModel,
    providerModelCatalogs,
    resolvedEffort,
    resolvedModel,
    setEngineSelectedModelIdByType,
    threadAccessMode,
  } = useAppShellComposerModelSection({
    accessMode,
    activeEngine,
    activeThreadId,
    activeWorkspaceId,
    appSettings,
    appSettingsLoading,
    applySelectedCollaborationMode,
    collaborationModes,
    composerInputRef,
    composerSelectionResolverRef,
    engineModelCatalogsAsOptions,
    engineModelsAsOptions,
    globalSelectionReady,
    handleSelectComposerSelection,
    handleSetAccessMode,
    models,
    modelsReady,
    persistComposerEnginePref,
    persistComposerSelectionForThread,
    queueSaveSettings,
    selectedCollaborationMode,
    selectedCollaborationModeId,
    selectedComposerSelection,
    selectedEffort,
    selectedModelId,
    setAppSettings,
    setSelectedEffort,
    setSelectedModelId,
  });
  const {
    selectedAgent,
    selectedAgentRef,
    handleSelectAgent,
    reloadSelectedAgent,
    reloadAgentCatalog,
  } = useSelectedAgentSession({
    activeThreadId,
    activeWorkspaceId,
    resolveCanonicalThreadId,
    onDebug: addDebugEntry,
  });

  useClaudeModelRefreshOnNewThread({
    activeEngine,
    activeThreadId,
    activeWorkspaceId,
    addDebugEntry,
    refreshEngineModels,
  });

  const { handleUserInputSubmitWithPlanApply, handleExitPlanModeExecute } =
    usePlanApplyHandlers({
      activeEngine,
      applySelectedCollaborationMode,
      handleSetAccessMode,
      handleUserInputSubmit,
      interruptTurn,
      resolveCollaborationRuntimeMode,
      resolveCollaborationUiMode,
      resolvedEffort,
      resolvedModel,
      selectedCollaborationModeId,
      sendUserMessage,
    });
  const {
    activeAccount,
    accountSwitching,
    handleSwitchAccount,
    handleCancelSwitchAccount,
  } = useAccountSwitching({
    activeWorkspaceId,
    accountByWorkspace,
    refreshAccountInfo,
    refreshAccountRateLimits,
    alertError,
  });
  const activeThreadIdRef = useRef<string | null>(activeThreadId ?? null);
  const { getThreadRows } = useThreadRows(threadParentById);
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId ?? null;
  }, [activeThreadId]);

  useEffect(() => {
    void reloadAgentCatalog();
  }, [reloadAgentCatalog]);

  useEffect(() => {
    if (!settingsOpen) {
      forceRefreshAgents();
      void reloadAgentCatalog();
    }
  }, [reloadAgentCatalog, settingsOpen]);

  useAutoExitEmptyDiff({
    centerMode,
    autoExitEnabled: diffSource === "local",
    activeDiffCount: activeDiffs.length,
    activeDiffLoading,
    activeDiffError,
    activeThreadId,
    isCompact,
    setCenterMode,
    setSelectedDiffPath,
    setActiveTab,
  });

  const { handleCopyThread } = useCopyThread({
    activeItems,
    onDebug: addDebugEntry,
  });

  const {
    renamePrompt,
    openRenamePrompt,
    handleRenamePromptChange,
    handleRenamePromptCancel,
    handleRenamePromptConfirm,
  } = useRenameThreadPrompt({
    threadsByWorkspace,
    renameThread,
  });

  const {
    deletePrompt: deleteThreadPrompt,
    isDeleting: isDeleteThreadPromptBusy,
    openDeletePrompt: openDeleteThreadPrompt,
    handleDeletePromptCancel: handleDeleteThreadPromptCancel,
    handleDeletePromptConfirm: handleDeleteThreadPromptConfirm,
  } = useDeleteThreadPrompt({
    threadsByWorkspace,
    removeThread,
    onDeleteSuccess: (threadId) => {
      clearDraftForThread(threadId);
      removeImagesForThread(threadId);
    },
    onDeleteError: (message) => {
      alertError(message ?? t("workspace.deleteConversationFailed"));
    },
  });

  const handleRenameThread = useCallback(
    (workspaceId: string, threadId: string) => {
      openRenamePrompt(workspaceId, threadId);
    },
    [openRenamePrompt],
  );

  const { exitDiffView, selectWorkspace, selectHome } = useWorkspaceSelection({
    workspaces,
    isCompact,
    activeWorkspaceId,
    setActiveTab,
    setActiveWorkspaceId,
    updateWorkspaceSettings,
    setCenterMode,
    setSelectedDiffPath,
  });

  const latestAgentRuns = useMemo(
    () =>
      buildLatestAgentRuns({
        getWorkspaceGroupName,
        lastAgentMessageByThread,
        threadStatusById,
        threadsByWorkspace,
        workspaces,
      }),
    [
      getWorkspaceGroupName,
      lastAgentMessageByThread,
      threadStatusById,
      threadsByWorkspace,
      workspaces,
    ],
  );
  const isLoadingLatestAgents = useMemo(
    () =>
      resolveLatestAgentFeedLoading({ hasLoaded, threadListLoadingByWorkspace, workspaces }),
    [hasLoaded, threadListLoadingByWorkspace, workspaces],
  );

  const activeRateLimits = activeWorkspaceId
    ? (rateLimitsByWorkspace[activeWorkspaceId] ?? null)
    : null;
  const activeTokenUsage = activeThreadId
    ? (tokenUsageByThread[activeThreadId] ?? null)
    : null;
  const timelinePlan = useMemo(
    () => extractPlanFromTimelineItems(activeItems),
    [activeItems],
  );
  const activePlan = activeThreadId
    ? (timelinePlan ?? planByThread[activeThreadId] ?? null)
    : timelinePlan;
  useCollaborationModeThreadSync({
    activeEngine,
    activeThreadId,
    activeThreadIdForModeRef,
    appSettingsLoading,
    codexComposerModeRef,
    collaborationUiModeByThread,
    lastCodexModeSyncThreadRef,
    selectedCollaborationModeId,
    setSelectedCollaborationModeId,
  });
  const {
    closePlanPanel,
    hasActivePlan,
    hasPlanData,
    isPlanMode,
    isPlanPanelDismissed,
    openPlanPanel,
    selectedKanbanTaskId,
    setIsPlanPanelDismissed,
    setSelectedKanbanTaskId,
    setWorkspaceHomeWorkspaceId,
    showGitHistory,
    showHome,
    showKanban,
    showWorkspaceHome,
    workspaceHomeWorkspaceId,
  } = useAppShellViewStateSection({
    activePlan,
    activeTab,
    activeThreadId,
    activeEditorFilePath,
    activeWorkspace,
    activeWorkspaceId,
    appMode,
    expandRightPanel,
    homeOpen,
    homeWorkspaceDefaultId,
    isCompact,
    isTablet,
    selectedCollaborationMode,
    setActiveThreadId,
    setActiveWorkspaceId,
    setHomeOpen,
    tabletTab,
  });
  const canInterrupt = activeThreadId
    ? (threadStatusById[activeThreadId]?.isProcessing ?? false)
    : false;
  const isProcessing = activeThreadId
    ? (threadStatusById[activeThreadId]?.isProcessing ?? false)
    : false;
  const isReviewing = activeThreadId
    ? (threadStatusById[activeThreadId]?.isReviewing ?? false)
    : false;
  const activeTurnId = activeThreadId
    ? (activeTurnIdByThread[activeThreadId] ?? null)
    : null;
  // An open AskUserQuestion for the active thread holds the send queue — the CLI
  // turn is blocked awaiting the answer. Mirror AskUserQuestionDialog's filter:
  // match on workspace + thread_id (empty thread_id = current thread).
  const hasPendingUserInput = useMemo(
    () =>
      Boolean(activeThreadId) &&
      userInputRequests.some((req) => {
        const requestThreadId = (req.params.thread_id ?? "").trim();
        if (requestThreadId && requestThreadId !== activeThreadId) return false;
        if (activeWorkspaceId && req.workspace_id !== activeWorkspaceId) return false;
        return true;
      }),
    [userInputRequests, activeThreadId, activeWorkspaceId],
  );
  const {
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    removeImagesForThread,
    activeQueue,
    activeQueuedHandoffBubble,
    handleSend,
    queueMessage,
    prefillDraft,
    setPrefillDraft,
    composerInsert,
    setComposerInsert,
    getActiveDraft,
    handleDraftChange,
    handleSendPrompt,
    handleEditQueued,
    handleDeleteQueued,
    handleFuseQueued,
    canFuseActiveQueue,
    activeFusingMessageId,
    clearDraftForThread,
  } = useComposerController({
    activeThreadId,
    activeItems,
    activeTurnId,
    activeContinuationPulse: activeThreadId
      ? (threadStatusById[activeThreadId]?.continuationPulse ?? 0)
      : 0,
    activeTerminalPulse: activeThreadId
      ? (threadStatusById[activeThreadId]?.terminalPulse ?? 0)
      : 0,
    activeWorkspaceId,
    activeWorkspace,
    isProcessing,
    isReviewing,
    hasPendingUserInput,
    steerEnabled: appSettings.experimentalSteerEnabled,
    activeEngine,
    resolveCanonicalThreadId,
    connectWorkspace,
    startThreadForWorkspace,
    sendUserMessage,
    sendUserMessageToThread,
    handleFusionStalled,
    startFork,
    startReview,
    startResume,
    startMcp,
    startSpecRoot,
    startStatus,
    startContext,
    startCompact,
    startFast,
    startMode,
    startExport,
    startImport,
    startLsp,
    startShare,
    setCodexCollaborationMode,
    getCodexCollaborationMode: () => {
      const threadMode = activeThreadId
        ? (collaborationUiModeByThread[activeThreadId] ?? null)
        : null;
      if (threadMode === "plan" || threadMode === "code") {
        return threadMode;
      }
      if (
        selectedCollaborationModeId === "plan" ||
        selectedCollaborationModeId === "code"
      ) {
        return selectedCollaborationModeId;
      }
      return "code";
    },
    getCodexCollaborationPayload: () => collaborationModePayload,
    interruptTurn,
  });
  const {
    activePath,
    activeWorkspaceKanbanTasks,
    activeWorkspaceThreads,
    ensureWorkspaceThreadListLoaded,
    handleEnsureWorkspaceThreadsForSettings,
    handleInsertComposerText,
    historySearchItems,
    hydratedThreadListWorkspaceIdsRef,
    listThreadsForWorkspaceTracked,
    lockLiveSessions,
    perfSnapshotRef,
    RECENT_THREAD_LIMIT,
    recentThreads,
    scopedKanbanTasks,
    searchResults,
    sessionRadarFeed,
    workspaceActivity,
    workspaceNameByPath,
    workspaceSearchSources,
  } = useAppShellSearchRadarSection({
    activeItems,
    activeThreadId,
    activeWorkspace,
    activeWorkspaceId,
    appSettings,
    commands,
    composerInputRef,
    completionTrackerBySessionRef,
    completionTrackerReadyRef,
    directories,
    filePanelMode,
    fileTreeSourceVersion,
    files,
    getActiveDraft,
    globalSearchFilesByWorkspace,
    handleDraftChange,
    isCompact,
    isFilesLoading,
    isProcessing,
    isSearchPaletteOpen,
    kanbanTasks,
    lastAgentMessageByThread,
    listThreadsForWorkspace,
    rightPanelCollapsed,
    searchContentFilters,
    searchPaletteQuery,
    searchScope,
    setGlobalSearchFilesByWorkspace,
    skills,
    t,
    threadItemsByThread,
    threadListLoadingByWorkspace,
    threadParentById,
    threadStatusById,
    threadsByWorkspace,
    workspaces,
    workspacesById,
  });
  const {
    renameWorktreePrompt,
    renameWorktreeNotice,
    renameWorktreeUpstreamPrompt,
    confirmRenameWorktreeUpstream,
    openRenameWorktreePrompt,
    handleOpenRenameWorktree,
    handleRenameWorktreeChange,
    handleRenameWorktreeCancel,
    handleRenameWorktreeConfirm,
    terminalTabs,
    activeTerminalId,
    onSelectTerminal,
    onNewTerminal,
    onCloseTerminal,
    terminalState,
    ensureLaunchTerminal,
    ensureTerminalWithTitle,
    restartTerminalSession,
    launchScriptState,
    runtimeRunState,
    handleToggleRuntimeConsole,
    handleToggleTerminalPanel,
    launchScriptsState,
    worktreeSetupScriptState,
    handleWorktreeCreated,
    resolveCloneProjectContext,
    handleSelectOpenAppId,
    navigateToThread,
    handleOpenMailSession,
    handleOpenClaudeTui,
    handleSelectStatusPanelSubagent,
    openAppIconById,
    persistProjectCopiesFolder,
    clonePrompt,
    openClonePrompt,
    confirmClonePrompt,
    cancelClonePrompt,
    updateCloneCopyName,
    chooseCloneCopiesFolder,
    useSuggestedCloneCopiesFolder,
    clearCloneCopiesFolder,
    handleArchiveActiveThread,
  } = useAppShellWorkspaceFlowsSection({
    activeThreadId,
    activeEditorFilePath,
    activeWorkspace,
    activeWorkspaceId,
    addCloneAgent,
    addDebugEntry,
    alertError,
    appSettings,
    clearDraftForThread,
    closeSettings,
    closeTerminalPanel,
    collapseRightPanel,
    connectWorkspace,
    centerMode,
    exitDiffView,
    handleToggleTerminal,
    isCompact,
    listThreadsForWorkspaceTracked,
    openTerminal,
    queueSaveSettings: (nextSettings) =>
      queueSaveSettings({
        ...appSettings,
        ...nextSettings,
      }),
    refreshThread,
    removeImagesForThread,
    removeThread,
    renameWorktree,
    renameWorktreeUpstream,
    resetWorkspaceThreads,
    selectWorkspace,
    setActiveEngine,
    setActiveTab,
    setActiveThreadId,
    setAgentTaskScrollRequest,
    setAppMode,
    setAppSettings: (updater) => {
      setAppSettings((current) => {
        const nextSettings =
          typeof updater === "function" ? updater(current) : updater;
        return {
          ...current,
          ...nextSettings,
        };
      });
    },
    setCenterMode,
    setHomeOpen,
    setSelectedKanbanTaskId,
    t,
    terminalOpen,
    threadsByWorkspace,
    updateWorkspaceSettings,
    workspaces,
  });

  const {
    worktreePrompt,
    worktreeCreateResult,
    openPrompt: openWorktreePrompt,
    confirmPrompt: confirmWorktreePrompt,
    cancelPrompt: cancelWorktreePrompt,
    closeWorktreeCreateResult,
    updateBranch: updateWorktreeBranch,
    updateBaseRef: updateWorktreeBaseRef,
    updatePublishToOrigin: updateWorktreePublishToOrigin,
    updateSetupScript: updateWorktreeSetupScript,
  } = useWorktreePrompt({
    addWorktreeAgent,
    updateWorkspaceSettings,
    connectWorkspace,
    onSelectWorkspace: selectWorkspace,
    onWorktreeCreated: handleWorktreeCreated,
    onCompactActivate: isCompact ? () => setActiveTab("codex") : undefined,
    onError: (message) => {
      addDebugEntry({
        id: `${Date.now()}-client-add-worktree-error`,
        timestamp: Date.now(),
        source: "error",
        label: "worktree/add error",
        payload: message,
      });
    },
  });

  const {
    statuses: repositoryStatuses,
    isLoading: repositoryStatusesLoading,
    isMultiRepository,
    refresh: refreshRepositoryStatuses,
  } = useMultiRepositoryGitStatus(activeWorkspace, repositories);
  const handleStageRepositoryFile = useCallback(async (repositoryRoot: string, path: string) => {
    if (!activeWorkspace) return;
    await stageGitFile(activeWorkspace.id, path, repositoryRoot);
  }, [activeWorkspace]);
  const handleUnstageRepositoryFile = useCallback(async (repositoryRoot: string, path: string) => {
    if (!activeWorkspace) return;
    await unstageGitFile(activeWorkspace.id, path, repositoryRoot);
  }, [activeWorkspace]);
  const handleStageRepositoryAll = useCallback(async (repositoryRoot: string) => {
    if (!activeWorkspace) return;
    await stageGitAll(activeWorkspace.id, repositoryRoot);
  }, [activeWorkspace]);

  const {
    commitMessage,
    commitMessageLoading,
    commitMessageError,
    commitLoading,
    pushLoading,
    syncLoading,
    commitError,
    pushError,
    syncError,
    repositoryCommitSummary,
    onCommitMessageChange: handleCommitMessageChange,
    onGenerateCommitMessage: handleGenerateCommitMessage,
    onCommit: handleCommit,
    onCommitAndPush: handleCommitAndPush,
    onCommitAndSync: handleCommitAndSync,
    onPush: handlePush,
    onSync: handleSync,
    onCommitRepositories: handleCommitRepositories,
  } = useGitCommitController({
    activeWorkspace,
    activeWorkspaceId,
    activeWorkspaceIdRef,
    gitStatus,
    refreshGitStatus,
    refreshGitLog,
    onMutationComplete: refreshRepositories,
    repositoryStatuses,
    refreshRepositoryStatuses,
  });

  const {
    handleSendPromptToNewAgent,
    handleCreatePrompt,
    handleUpdatePrompt,
    handleDeletePrompt,
    handleMovePrompt,
    handleRevealWorkspacePrompts,
    handleRevealGeneralPrompts,
  } = useAppShellPromptActionsSection({
    activeWorkspace,
    alertError,
    connectWorkspace,
    createPrompt,
    deletePrompt,
    getGlobalPromptsDir,
    getWorkspacePromptsDir,
    movePrompt,
    sendUserMessageToThread,
    startThreadForWorkspace,
    updatePrompt,
  });

  const {
    activeParentWorkspace,
    activeRenamePrompt,
    baseWorkspaceRef,
    isWorktreeWorkspace,
    worktreeLabel,
    worktreeRename,
  } = useAppShellWorktreeChromeSection({
    activeTab,
    activeWorkspace,
    confirmRenameWorktreeUpstream,
    handleOpenRenameWorktree,
    handleRenameWorktreeCancel,
    handleRenameWorktreeChange,
    handleRenameWorktreeConfirm,
    isPhone,
    isTablet,
    renameWorktreeNotice,
    renameWorktreePrompt,
    renameWorktreeUpstreamPrompt,
    setActiveTab,
    workspacesById,
  });

  const { isMacDesktop, isWindowsDesktop } =
    useAppShellDesktopChrome(activeWorkspace);

  useWorkspaceRestore({
    workspaces,
    hasLoaded,
    activeWorkspaceId,
    restoreThreadsOnlyOnLaunch:
      appSettings.runtimeRestoreThreadsOnlyOnLaunch !== false,
    listThreadsForWorkspace: listThreadsForWorkspaceTracked,
  });
  useWorkspaceRefreshOnFocus({
    workspaces,
    refreshWorkspaces,
    activeWorkspaceId,
    listThreadsForWorkspace: listThreadsForWorkspaceTracked,
  });

  const {
    handleAddWorkspace,
    handleOpenNewWindow,
    handleAddWorkspaceFromPath,
    handleAddAgent,
    handleAddWorktreeAgent,
    handleAddCloneAgent,
  } = useWorkspaceActions({
    activeWorkspace,
    isCompact,
    activeEngine,
    newAgentShortcut: appSettings.newAgentShortcut,
    setActiveEngine,
    addWorkspace,
    addWorkspaceFromPath,
    connectWorkspace,
    startThreadForWorkspace,
    setActiveThreadId,
    setActiveTab,
    exitDiffView,
    selectWorkspace,
    openWorktreePrompt,
    openClonePrompt,
    composerInputRef,
    showLoadingProgressDialog,
    hideLoadingProgressDialog,
    onDebug: addDebugEntry,
  });

  const {
    handleDropWorkspacePaths,
    handleWorkspaceDragEnter,
    handleWorkspaceDragLeave,
    handleWorkspaceDragOver,
    handleWorkspaceDrop,
    isWorkspaceDropActive,
    workspaceDropTargetRef,
  } = useWorkspacePathsIntake({
    handleAddWorkspaceFromPath,
  });

  const runtimeThreadBoundary = defineRuntimeThreadShellBoundary({
    activeItems,
    activeThreadId,
    activeTurnId,
    activeTurnIdByThread,
    activeWorkspace,
    activeWorkspaceId,
    canInterrupt,
    completionEmailIntentByThread,
    handleFusionStalled,
    historyLoadingByThreadId,
    historyRestoredAtMsByThread,
    interruptTurn,
    isProcessing,
    isReviewing,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    rateLimitsByWorkspace,
    refreshAccountInfo,
    refreshAccountRateLimits,
    refreshThread,
    resetWorkspaceThreads,
    resolveCanonicalThreadId,
    sendUserMessage,
    sendUserMessageToThread,
    setActiveThreadId,
    startSharedSessionForWorkspace,
    startThreadForWorkspace,
    threadItemsByThread,
    threadListCursorByWorkspace,
    threadListLoadingByWorkspace,
    threadListPagingByWorkspace,
    threadParentById,
    threadStatusById,
    threadsByWorkspace,
    tokenUsageByThread,
    toggleCompletionEmailIntent,
    updateSharedSessionEngineSelection,
  });
  const runtimeActions = defineAppShellRuntimeActions({
    handleToggleRuntimeConsole,
    handleToggleTerminalPanel,
  });

  const agent = selectedAgent;
  const appShellDomainContextsRef = useRef<AppShellDomainContexts | null>(null);
  const rawAppShellDomainContexts = defineAppShellDomainContexts({
    runtimeThreadContext: {
      ...APP_SHELL_LEGACY_CONTEXT_DEFAULTS,
      ...runtimeActions,
      runtimeThreadBoundary,
    },
    workspaceNavigationContext: {
      GitHubPanelData,
      RECENT_THREAD_LIMIT,
      SettingsView,
      accessMode,
      accountByWorkspace,
      accountSwitching,
      activeAccount,
      activeDiffError,
      activeDiffLoading,
      activeDiffs,
      activeEditorFilePath,
      activeEditorLineRange,
      activeEngine,
      activeGitRoot,
      activeImages,
      activeFusingMessageId,
      fileCompareSession,
      activeItems,
      activeParentWorkspace,
      activePath,
      activePlan,
      activeQueue,
      activeQueuedHandoffBubble,
      activeRateLimits,
      activeRenamePrompt,
      activeTab,
      agentTaskScrollRequest,
      activeTerminalId,
      activeThreadId,
      activeThreadIdForModeRef,
      activeThreadIdRef,
      activeTurnId,
      activeTokenUsage,
      activeWorkspace,
      activeWorkspaceId,
      activeWorkspaceIdRef,
      activeWorkspaceKanbanTasks,
      activeWorkspaceRef,
      activeWorkspaceThreads,
      addCloneAgent,
      addDebugEntry,
      addWorkspace,
      addWorkspaceFromPath,
      addWorktreeAgent,
      agent,
      alertError,
      appMode,
      appRootRef,
      appSettings,
      appSettingsLoading,
      approvals,
      assignWorkspaceGroup,
      attachImages,
      baseWorkspaceRef,
      branches,
      branchError,
      currentBranch,
      localBranches,
      remoteBranches,
      repositories,
      repositoriesLoading,
      repositoryError,
      repositoryStatuses,
      repositoryStatusesLoading,
      isMultiRepository,
      refreshRepositoryStatuses,
      handleStageRepositoryFile,
      handleUnstageRepositoryFile,
      handleStageRepositoryAll,
      handleCommitRepositories,
      repositoryCommitSummary,
      selectedRepositoryRoot,
      selectRepository,
      canFuseActiveQueue,
      canInterrupt,
      cancelClonePrompt,
      cancelWorktreePrompt,
      centerMode,
      checkoutBranch,
      chooseCloneCopiesFolder,
      choosePreset,
      claudeAccessModeRef,
      claudeThinkingVisible,
      clearActiveImages,
      clearCloneCopiesFolder,
      clearDebugEntries,
      clearDictationError,
      clearDictationHint,
      clearDictationTranscript,
      clearDraftForThread,
      clearGitRootCandidates,
      clonePrompt,
      closePlanPanel,
      closeReleaseNotes,
      closeReviewPrompt,
      closeSettings,
      closeTerminalPanel,
      closeWorktreeCreateResult,
      codexComposerModeRef,
      collapseRightPanel,
      collapseSidebar,
      commands,
      commitError,
      commitLoading,
      commitMessage,
      commitMessageError,
      commitMessageLoading,
      completionEmailIntentByThread,
      completionTrackerBySessionRef,
      completionTrackerReadyRef,
      composerEditorSettings,
      composerInputRef,
      composerInsert,
      confirmBranch,
      confirmClonePrompt,
      confirmCommit,
      confirmCustom,
      confirmRenameWorktreeUpstream,
      confirmWorktreePrompt,
      connectWorkspace,
      createBranch,
      createPrompt,
      createWorkspaceGroup,
      debugEntries,
      debugOpen,
      debugPanelHeight,
      deletePrompt,
      deleteThreadPrompt,
      deleteWorkspaceGroup,
      deletingWorktreeIds,
      dictationError,
      dictationHint,
      dictationLevel,
      dictationModel,
      dictationReady,
      dictationState,
      dictationTranscript,
      diffScrollRequestId,
      diffSource,
      directories,
      directoryMetadata,
      dismissErrorToast,
      dismissUpdate,
      doctor,
      claudeDoctor,
      editorHighlightTarget,
      editorNavigationTarget,
      editorSplitCompanion,
      editorSplitLayout,
      engineModelsAsOptions,
      engineSelectedModelIdByType,
      engineStatuses,
      ensureLaunchTerminal,
      ensureTerminalWithTitle,
      ensureWorkspaceThreadListLoaded,
      errorToasts,
      exitDiffView,
      expandRightPanel,
      expandSidebar,
      filePanelMode,
      fileReferenceMode,
      fileStatus,
      fileTreeLoadError,
      fileTreeSourceVersion,
      files,
      forkThreadForWorkspace,
      forkSessionFromMessageForWorkspace,
      forkClaudeSessionFromMessageForWorkspace,
      getGlobalPromptsDir,
      getPinTimestamp,
      getThreadRows,
      getWorkspaceGroupName,
      getWorkspacePromptsDir,
      gitCommitDiffs,
      gitDiffListView,
      gitDiffViewStyle,
      gitHistoryPanelHeight,
      gitHistoryPanelHeightRef,
      gitIssues,
      gitIssuesError,
      gitIssuesLoading,
      gitIssuesTotal,
      gitLogAhead,
      gitLogAheadEntries,
      gitLogBehind,
      gitLogBehindEntries,
      gitLogEntries,
      gitLogError,
      gitLogLoading,
      gitLogTotal,
      gitLogUpstream,
      gitPanelMode,
      gitPullRequestComments,
      gitPullRequestCommentsError,
      gitPullRequestCommentsLoading,
      gitPullRequestDiffs,
      gitPullRequestDiffsError,
      gitPullRequestDiffsLoading,
      gitPullRequests,
      gitPullRequestsError,
      gitPullRequestsLoading,
      gitPullRequestsTotal,
      gitRemoteUrl,
      gitRootCandidates,
      gitRootScanDepth,
      gitRootScanError,
      gitRootScanHasScanned,
      gitRootScanLoading,
      gitStatus,
      gitignoredDirectories,
      gitignoredFiles,
      globalSearchFilesByWorkspace,
    },
    composerContext: {
      groupedWorkspaces,
      handleActivateFileTab,
      handleActiveDiffPath,
      handleAddAgent,
      handleAddCloneAgent,
      handleAddWorkspace,
      handleOpenNewWindow,
      handleAddWorkspaceFromPath,
      handleAddWorktreeAgent,
      handleAppModeChange,
      handleApplyWorktreeChanges,
      handleApprovalBatchAccept,
      handleApprovalDecision,
      handleApprovalRemember,
      handleArchiveActiveThread,
      handleCancelSwitchAccount,
      handleCheckoutBranch,
      handleCloseAllFileTabs,
      handleCloseFileTab,
      handleCommit,
      handleCommitAndPush,
      handleCommitAndSync,
      handleCommitMessageChange,
      handleCopyDebug,
      handleCopyThread,
      handleCreateBranch,
      handleUpdateBranch,
      handleCreatePrompt,
      handleDebugClick,
      handleDeletePrompt,
      handleDeleteQueued,
      handleDeleteThreadPromptCancel,
      handleDeleteThreadPromptConfirm,
      handleDraftChange,
      handleDropWorkspacePaths,
      handleEditQueued,
      handleEnsureWorkspaceThreadsForSettings,
      handleExitEditor,
      handleGenerateCommitMessage,
      handleGitIssuesChange,
      handleGitPanelModeChange,
      handleGitPullRequestCommentsChange,
      handleGitPullRequestDiffsChange,
      handleGitPullRequestsChange,
      handleInsertComposerText,
      handleLockPanel,
      handleMovePrompt,
      handleOpenDetachedFileExplorer,
      handleOpenFile,
      handleOpenWorkspaceFileCompare,
      handleOpenScratchFileCompare,
      handleCloseFileCompare,
      handleOpenMailSession,
      handleOpenModelSettings,
      handleRefreshModelConfig,
      handleReorderFileTabs,
      handleOpenRenameWorktree,
      handleResolvedClaudeThinkingVisibleChange,
      handlePickGitRoot,
      handlePush,
      handleRenamePromptCancel,
      handleRenamePromptChange,
      handleRenamePromptConfirm,
      handleRenameThread,
      handleRenameWorktreeCancel,
      handleRenameWorktreeChange,
      handleRenameWorktreeConfirm,
      handleRevealGeneralPrompts,
      handleRevealWorkspacePrompts,
      handleRevertAllGitChanges,
      handleRevertGitFile,
      handleReviewPromptKeyDown,
      handleSelectAgent,
      handleSelectCommit,
      handleSelectDiff,
      handleSelectModel,
      handleSelectOpenAppId,
      handleSelectOpenCodeAgent,
      handleSelectOpenCodeVariant,
      handleSelectStatusPanelSubagent,
      handleSend,
      handleSendPrompt,
      handleSendPromptToNewAgent,
      handleSetAccessMode,
      handleSetGitRoot,
      handleStageGitAll,
      handleStageGitFile,
      handleSwitchAccount,
      handleFuseQueued,
      handleSync,
      handleTestNotificationSound,
      handleToggleDictation,
      handleToggleRuntimeConsole,
      handleToggleTerminal,
      handleToggleTerminalPanel,
      handleUnlockPanel,
      handleUnstageGitFile,
      handleUpdatePrompt,
      handleUserInputSubmit,
      handleUserInputSubmitWithPlanApply,
      handleExitPlanModeExecute,
      handleWorkspaceDragEnter,
      handleWorkspaceDragLeave,
      handleWorkspaceDragOver,
      handleWorkspaceDrop,
      handleWorktreeCreated,
      hasActivePlan,
      hasLoaded,
      hasPlanData,
      highlightedBranchIndex,
      highlightedCommitIndex,
      highlightedPresetIndex,
      historySearchItems,
      hydratedThreadListWorkspaceIdsRef,
      availableEngines,
      installedEngines,
      interruptTurn,
      isCompact,
      isDeleteThreadPromptBusy,
      isEditorFileMaximized,
      isFilesLoading,
      isLoadingLatestAgents,
      isMacDesktop,
      isModelConfigRefreshing,
      isPanelLocked,
      isPhone,
      isPlanMode,
      isPlanPanelDismissed,
      isProcessing,
      isReviewing,
      isSearchPaletteOpen,
    },
    layoutContext: {
      isTablet,
      isThreadAutoNaming,
      isThreadPinned,
      isWindowsDesktop,
      isWorkspaceDropActive,
      isWorktreeWorkspace,
      kanbanConversationWidth,
      kanbanCreatePanel,
      kanbanCreateTask,
      kanbanDeletePanel,
      kanbanDeleteTask,
      kanbanPanels,
      kanbanReorderTask,
      kanbanTasks,
      kanbanUpdatePanel,
      kanbanUpdateTask,
      kanbanViewState,
      lastAgentMessageByThread,
      lastCodexModeSyncThreadRef,
      latestAgentRuns,
      launchScriptState,
      launchScriptsState,
      listThreadsForWorkspace,
      listThreadsForWorkspaceTracked,
      liveEditPreviewEnabled,
      loadOlderThreadsForWorkspace,
      lockLiveSessions,
      markWorkspaceConnected,
      models,
      movePrompt,
      moveWorkspaceGroup,
      navigateToThread,
      handleOpenClaudeTui,
      normalizePath,
      onCloseTerminal,
      onDebugPanelResizeStart,
      onGitHistoryPanelResizeStart,
      onKanbanConversationResizeStart,
      onNewTerminal,
      onPlanPanelResizeStart,
      onRightPanelResizeStart,
      onSelectTerminal,
      onSidebarResizeStart,
      onTerminalPanelResizeStart,
      onTextareaHeightChange,
      openAppIconById,
      openClonePrompt,
      openCodeAgents,
      openDeleteThreadPrompt,
      openFileTabs,
      openPlanPanel,
      openReleaseNotes,
      openRenamePrompt,
      openRenameWorktreePrompt,
      openSettings,
      openTerminal,
      openWorktreePrompt,
      perfSnapshotRef,
      persistComposerSelectionForThread,
      persistProjectCopiesFolder,
      pickImages,
      pinThread,
      pinnedThreadsVersion,
      planByThread,
      planPanelHeight,
      prefillDraft,
      prompts,
      pushError,
      pushLoading,
      queueGitStatusRefresh,
      queueMessage,
      queueSaveSettings,
      rateLimitsByWorkspace,
      recentThreads,
      reduceTransparency,
      windowTransparencyEnabled,
      windowOpacity,
      refreshAccountInfo,
      refreshAccountRateLimits,
      refreshEngines,
      refreshFiles,
      refreshGitDiffs,
      refreshGitLog,
      refreshGitStatus,
      refreshThread,
      refreshWorkspaces,
      releaseNotesActiveIndex,
      releaseNotesEntries,
      releaseNotesError,
      releaseNotesLoading,
      releaseNotesOpen,
      reloadSelectedAgent,
      removeImage,
      removeImagesForThread,
      removeThread,
      removeThreads,
      removeWorkspace,
      removeWorktree,
      renamePrompt,
      renameThread,
      renameWorkspaceGroup,
      renameWorktree,
      renameWorktreeNotice,
      renameWorktreePrompt,
    },
    fileEditorContext: {
      renameWorktreeUpstream,
      renameWorktreeUpstreamPrompt,
      resetGitHubPanelState,
      resetSoloSplitToHalf,
      resetWorkspaceThreads,
      resolveCloneProjectContext,
      resolveCanonicalThreadId,
      resolveComposerSelectionForThread,
      resolveOpenCodeAgentForThread,
      resolveOpenCodeVariantForThread,
      restartTerminalSession,
      retryReleaseNotesLoad,
      reviewPrompt,
      rightPanelCollapsed,
      rightPanelWidth,
      scaleShortcutText,
      scaleShortcutTitle,
      scanGitRoots,
      scopedKanbanTasks,
      searchContentFilters,
      searchPaletteQuery,
      searchPaletteSelectedIndex,
      searchResults,
      searchScope,
      selectBranch,
      selectBranchAtIndex,
      selectCommit,
      selectCommitAtIndex,
      selectHome,
      selectWorkspace,
      selectedAgent,
      selectedCommitSha,
      selectedDiffPath,
      selectedAgentRef,
      selectedKanbanTaskId,
      selectedOpenCodeAgent,
      selectedOpenCodeVariant,
      selectedPullRequest,
      sendUserMessage,
    },
    settingsContext: {
      sendUserMessageToThread,
      setAccessMode,
      setActiveEditorLineRange,
      setActiveEngine,
      setActiveTab,
      setActiveThreadId,
      setActiveWorkspaceId,
      setAppMode,
      setAppSettings,
      setCenterMode,
      setComposerInsert,
      setDebugOpen,
      setDiffSource,
      setEditorSplitCompanion,
      setEditorSplitLayout,
      setEngineSelectedModelIdByType,
      setFilePanelMode,
      setFileReferenceMode,
      setGitDiffListView,
      setGitDiffViewStyle,
      setGitHistoryPanelHeight,
      setGitPanelMode,
      setGitRootScanDepth,
      setGlobalSearchFilesByWorkspace,
      setHighlightedBranchIndex,
      setHighlightedCommitIndex,
      setHighlightedPresetIndex,
      setIsEditorFileMaximized,
      setIsPanelLocked,
      setIsPlanPanelDismissed,
      setIsSearchPaletteOpen,
      setKanbanViewState,
      setLiveEditPreviewEnabled,
      setPrefillDraft,
      setReduceTransparency,
      setWindowTransparencyEnabled,
      setWindowOpacity,
      setRightPanelWidth,
      setSearchContentFilters,
      setSearchPaletteQuery,
      setSearchPaletteSelectedIndex,
      setSearchScope,
      setSelectedCommitSha,
      setSelectedDiffPath,
      setSelectedKanbanTaskId,
      setSelectedPullRequest,
      setHomeOpen,
      setWorkspaceHomeWorkspaceId,
      settingsHighlightTarget,
      settingsOpen,
      settingsSection,
      loadingProgressDialog,
      dismissLoadingProgressDialog,
      shouldLoadDiffs,
      shouldLoadGitHubPanelData,
      showLoadingProgressDialog,
      hideLoadingProgressDialog,
      showDebugButton,
      showGitHistory,
      showHome,
      showKanban,
      showNextReleaseNotes,
      showPresetStep,
      showPreviousReleaseNotes,
      showWorkspaceHome,
      sidebarCollapsed,
      sidebarWidth,
      skills,
      startCompact,
      startExport,
      startFast,
      startFork,
      startImport,
      startLsp,
      startMcp,
      startMode,
      startResume,
      startReview,
      startShare,
      startSpecRoot,
      startStatus,
      startThreadForWorkspace,
      startSharedSessionForWorkspace,
      startUpdate,
      syncError,
      syncLoading,
      t,
      tabletTab,
      terminalOpen,
      terminalPanelHeight,
      terminalState,
      terminalTabs,
      textareaHeight,
      threadAccessMode,
      threadItemsByThread,
      threadListCursorByWorkspace,
      threadListLoadingByWorkspace,
      threadListPagingByWorkspace,
      threadParentById,
      threadStatusById,
      historyLoadingByThreadId,
      historyRestoredAtMsByThread,
      threadsByWorkspace,
      timelinePlan,
      tokenUsageByThread,
      toggleCompletionEmailIntent,
      triggerAutoThreadTitle,
      ungroupedLabel,
      unpinThread,
      updateThreadParent,
      updateCloneCopyName,
      updateCustomInstructions,
      updatePrompt,
      updateSharedSessionEngineSelection,
      updateWorkspaceCodexBin,
      updateWorkspaceSettings,
      updateWorktreeBaseRef,
      updateWorktreeBranch,
      updateWorktreePublishToOrigin,
      updateWorktreeSetupScript,
      updaterState,
      useSuggestedCloneCopiesFolder,
      userInputRequests,
      workspaceActivity,
      workspaceDropTargetRef,
      workspaceFilesPollingEnabled,
      workspaceGroups,
      workspaceHomeWorkspaceId,
      workspaceNameByPath,
      homeWorkspaceDefaultId,
      homeWorkspaceSelectedId,
      workspaceSearchSources,
      workspaces,
      workspacesById,
      workspacesByPath,
      worktreeApplyError,
      worktreeApplyLoading,
      worktreeApplySuccess,
      worktreeCreateResult,
      worktreeLabel,
      worktreePrompt,
      worktreeRename,
      worktreeSetupScriptState,
      sessionRadarRunningSessions: sessionRadarFeed.runningSessions,
      sessionRadarRecentCompletedSessions:
        sessionRadarFeed.recentCompletedSessions,
      runningSessionCountByWorkspaceId:
        sessionRadarFeed.runningCountByWorkspaceId,
      recentCompletedSessionCountByWorkspaceId:
        sessionRadarFeed.recentCountByWorkspaceId,
    },
    runtimeContext: {
      runtimeRunState,
    },
    modelSelectionContext: {
      effectiveModels,
      effectiveReasoningSupported,
      effectiveSelectedModel,
      effectiveSelectedModelId,
      providerModelCatalogs,
      reasoningOptions: effectiveReasoningOptions,
      reasoningSupported: effectiveReasoningSupported,
      resolvedEffort,
      resolvedModel,
      selectedEffort: effectiveSelectedEffort,
      selectedModelId: effectiveSelectedModelId,
      setSelectedEffort: handleSelectComposerEffort,
      setSelectedModelId,
    },
    collaborationModeContext: {
      applySelectedCollaborationMode,
      collaborationModePayload,
      collaborationModes,
      collaborationModesEnabled,
      collaborationRuntimeModeByThread,
      collaborationUiModeByThread,
      handleCollaborationModeResolved,
      resolveCollaborationRuntimeMode,
      resolveCollaborationUiMode,
      selectedCollaborationMode,
      selectedCollaborationModeId,
      setCodexCollaborationMode,
      setCollaborationRuntimeModeByThread,
      setCollaborationUiModeByThread,
      setSelectedCollaborationModeId,
    },
  });
  const appShellDomainContexts = reuseStableAppShellDomainContexts(
    appShellDomainContextsRef.current,
    rawAppShellDomainContexts,
  );
  useEffect(() => {
    appShellDomainContextsRef.current = appShellDomainContexts;
  }, [appShellDomainContexts]);

  const searchAndComposerSection = useAppShellSearchAndComposerSection({
    activeEditorFilePath,
    activeWorkspace,
    activeWorkspaceId,
    appSettings,
    canInterrupt,
    centerMode,
    clearActiveImages,
    connectWorkspace,
    exitDiffView,
    filePanelMode,
    getActiveDraft,
    gitPanelMode,
    gitPullRequestDiffs,
    handleDraftChange,
    handleOpenFile,
    handleSend,
    interruptTurn,
    isCompact,
    isSearchPaletteOpen,
    kanbanTasks,
    queueMessage,
    searchPaletteQuery,
    searchResults,
    searchScope,
    selectWorkspace,
    selectedPullRequest,
    sendUserMessageToThread,
    setActiveTab,
    setActiveThreadId,
    setAppMode,
    setCenterMode,
    setDiffSource,
    setGitPanelMode,
    setIsSearchPaletteOpen,
    setKanbanViewState,
    setPrefillDraft,
    setSearchContentFilters,
    setSearchPaletteQuery,
    setSearchPaletteSelectedIndex,
    setSearchScope,
    setSelectedCommitSha,
    setSelectedDiffPath,
    setSelectedKanbanTaskId,
    setSelectedPullRequest,
    startThreadForWorkspace,
    workspacesByPath,
  });

  const sections = useAppShellSections({
    appShellDomainContexts,
    searchAndComposerSection,
  });

  const isPullRequestComposer = sections.isPullRequestComposer;

  const layoutNodes = useAppShellLayoutNodesSection({
    appShellDomainContexts,
    searchAndComposerSection,
    sections,
    isPullRequestComposer,
    isPullRequestComposerFromSections: sections.isPullRequestComposer,
  });

  return renderAppShell({
    appShellDomainContexts,
    searchAndComposerSection,
    sections,
    layoutNodes,
    isPullRequestComposer,
    isPullRequestComposerFromSections: sections.isPullRequestComposer,
  });
}
