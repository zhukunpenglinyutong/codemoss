import {
  lazy,
  Profiler,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { useDeferredFrameAccumulator } from "./useDeferredFrameAccumulator";
import { useTranslation } from "react-i18next";
import { Sidebar } from "../../app/components/Sidebar";
import { HomeChat } from "../../home/components/HomeChat";
import { MainHeader } from "../../app/components/MainHeader";
import {
  CODEX_DISK_PROVIDER_PROFILE_ID,
  type CodexProviderProfileSelection,
  type CodexProviderProfileOption,
} from "../../threads/constants/codexProviderProfiles";
import { UpdateToast } from "../../update/components/UpdateToast";
import { ErrorToasts } from "../../notifications/components/ErrorToasts";
import { GlobalRuntimeNoticeDock } from "../../notifications/components/GlobalRuntimeNoticeDock";
import type { ComposerRewindDialogRequest } from "../../composer/components/Composer";
import { resolveCodexProviderLabel } from "../../app/utils/codexProviderLabel";
import { GitDiffViewer } from "../../git/components/GitDiffViewer";
import { buildCanonicalGitChanges } from "../../git/utils/gitChangeModel";
import { FileTreePanel } from "../../files/components/FileTreePanel";
import { WorkspaceSearchPanel } from "../../search/components/WorkspaceSearchPanel";
import { PromptPanel } from "../../prompts/components/PromptPanel";
import { ProjectMemoryPanel } from "../../project-memory/components/ProjectMemoryPanel";
import type {
  CanvasSemanticGraph,
  IntentCanvasCodeSelectionAnchor,
} from "../../intent-canvas/types";
import { pushErrorToast } from "../../../services/toasts";
import {
  buildGitStatusProjectMapImpactInput,
  type ProjectMapImpactInput,
} from "../../project-map/utils/impactSources";
import {
  OrchestrationCenterView,
  applyOrchestrationReviewAction,
  archiveOrchestrationTask,
  collectCoreOrchestrationProviderSnapshots,
  createManualOrchestrationTaskDraft,
  projectLinkedTaskRunsToOrchestrationStore,
  OPEN_ORCHESTRATION_TASK_EVENT,
  patchOrchestrationTask,
  readOpenOrchestrationTaskEvent,
  readSpecHubOrchestrationCandidates,
  saveOrchestrationTaskStore,
  upsertOrchestrationTask,
  useOrchestrationTaskStore,
} from "../../agent-orchestration";
import type {
  OrchestrationCancelRunRequest,
  OrchestrationDispatchConfirmation,
  OrchestrationManualTaskDraftRequest,
  OrchestrationReviewActionRequest,
  OrchestrationSourceRef,
  OrchestrationTask,
} from "../../agent-orchestration";
import { useTaskRunStore } from "../../tasks/hooks/useTaskRunStore";
import {
  patchTaskRun,
  saveTaskRunStore,
} from "../../tasks/utils/taskRunStorage";
import { WorkspaceNoteCardPanel } from "../../note-cards/components/WorkspaceNoteCardPanel";
import { WorkspaceSessionActivityPanel } from "../../session-activity/components/WorkspaceSessionActivityPanel";
import { WorkspaceSessionRadarPanel } from "../../session-activity/components/WorkspaceSessionRadarPanel";
import { TabBar } from "../../app/components/TabBar";
import { TabletNav } from "../../app/components/TabletNav";
import { useStatusPanelData } from "../../status-panel/hooks/useStatusPanelData";
import { useGlobalRuntimeNoticeDock } from "../../notifications/hooks/useGlobalRuntimeNoticeDock";
import { buildSpecWorkspaceSnapshot } from "../../../lib/spec-core/runtime";
import type { SpecWorkspaceSnapshot } from "../../../lib/spec-core/types";
import type { TabType } from "../../status-panel/types";
import type {
  EditorNavigationLocation,
  OpenFileOptions,
} from "../../app/hooks/useGitPanelController";
import type {
  CustomCommandOption,
  EngineType,
  RequestUserInputRequest,
  ThreadSummary,
} from "../../../types";
import { __profile as threadsRuntimeProfile } from "../../threads/hooks/useThreadsReducer";
import { getClientStoreSync } from "../../../services/clientStorage";
import { getCodexProviders } from "../../../services/tauri";
import { normalizeSpecRootInput } from "../../spec/pathUtils";
import type {
  CodeAnnotationBridgeProps,
  CodeAnnotationDraftInput,
  CodeAnnotationSelection,
} from "../../code-annotations/types";
import {
  buildCodeAnnotationDedupeKey,
  createCodeAnnotationSelection,
} from "../../code-annotations/utils/codeAnnotations";
import type {
  ConversationEngine,
  ConversationState,
} from "../../threads/contracts/conversationCurtainContracts";
import { resolveDiffPathFromWorkspacePath } from "../../../utils/workspacePaths";
import { resolvePresentationProfile } from "../../messages/presentation/presentationProfile";
import { appendQueuedHandoffBubbleIfNeeded } from "../../threads/utils/queuedHandoffBubble";
import { isBackgroundRenderGatingEnabled } from "../../threads/utils/realtimePerfFlags";
import { useWorkspaceSessionActivity } from "../../session-activity/hooks/useWorkspaceSessionActivity";
import { useClientUiVisibility } from "../../client-ui-visibility/hooks/useClientUiVisibility";
import {
  getHomeWorkspaceOptions,
  resolveHomeWorkspaceId,
} from "../../home/utils/homeWorkspaceOptions";
import { deriveRewindWorkspaceGitState } from "./rewindWorkspaceGitState";
import { buildWorkspaceHeaderGroups } from "./workspaceHeaderGroups";
import { loadCodeSelectionRelationshipGraph } from "./codeSelectionRelationshipGraph";
import { resolveRuntimeLifecycleForComposer } from "./runtimeLifecycle";
import { focusUserInputRequestCard } from "./userInputRequestFocus";
import { dispatchMessageJumpEvent } from "./messageJumpEvent";
import {
  EMPTY_ACTIVE_CANVAS_ITEMS,
  EMPTY_ACTIVE_CANVAS_TASK_RUNS,
  setActiveCanvasSnapshot,
  type ActiveCanvasSnapshot,
} from "./activeCanvasStore";
import { ActiveCanvasComposer } from "./activeCanvasComposerNode";
import { ActiveCanvasStatusPanel } from "./activeCanvasStatusPanelNode";
import { buildShellRuntimeSummary } from "./layoutShellSummary";
import { buildConversationCanvasNode } from "./conversationCanvasNode";
import { useLayoutTopbarSessionTabs } from "./useLayoutTopbarSessionTabs";
import {
  buildCompactEmptyNode,
  buildCompactGitBackNode,
  buildDebugPanelNodes,
  buildDesktopTopbarLeftNode,
  buildRightPanelToolbarNode,
  buildTerminalDockNode,
} from "./layoutNodeSections";

const GitDiffPanel = lazy(() =>
  import("../../git/components/GitDiffPanel").then((m) => ({
    default: m.GitDiffPanel,
  })),
);
const FileViewPanel = lazy(() =>
  import("../../files/components/FileViewPanel").then((m) => ({
    default: m.FileViewPanel,
  })),
);
const ProjectMapPanel = lazy(() =>
  import("../../project-map/components/ProjectMapPanel").then((m) => ({
    default: m.ProjectMapPanel,
  })),
);
const IntentCanvasManager = lazy(() =>
  import("../../intent-canvas/components/IntentCanvasManager").then((m) => ({
    default: m.IntentCanvasManager,
  })),
);

function HeavyPanelFallback() {
  return <div className="heavy-panel-fallback" aria-hidden="true" />;
}

import type {
  LayoutNodesFlatOptions,
  LayoutNodesOptions,
  LayoutNodesResult,
  RightPanelTabSelection,
} from "./layoutNodesTypes";
const EMPTY_COMMANDS: CustomCommandOption[] = [];
const EMPTY_PROJECT_MAP_IMPACT_INPUT: ProjectMapImpactInput = {
  filePaths: [],
  source: {
    kind: "none",
    label: "No impact source",
    fileCount: 0,
  },
};
let lastOrchestrationProjectionSignature: string | null = null;

function buildOrchestrationProjectionSignature(
  orchestrationTaskStore: ReturnType<typeof useOrchestrationTaskStore>,
  taskRuns: ReturnType<typeof useTaskRunStore>["runs"],
): string {
  return JSON.stringify({
    tasks: orchestrationTaskStore.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      reviewState: task.reviewState,
      linkedRunIds: task.linkedRunIds,
    })),
    runs: taskRuns.map((run) => ({
      runId: run.runId,
      taskId: run.task.taskId,
      orchestrationTaskId: run.task.orchestrationTaskId,
      status: run.status,
      updatedAt: run.updatedAt,
    })),
  });
}

function toConversationEngine(
  engine: EngineType | undefined,
): ConversationEngine {
  if (engine === "claude" || engine === "gemini" || engine === "opencode") {
    return engine;
  }
  return "codex";
}

function inferConversationEngineFromThreadId(
  threadId: string | null | undefined,
): ConversationEngine | null {
  const normalizedThreadId = threadId?.trim().toLowerCase();
  if (!normalizedThreadId) {
    return null;
  }

  if (
    normalizedThreadId.startsWith("claude:") ||
    normalizedThreadId.startsWith("claude-pending-")
  ) {
    return "claude";
  }
  if (
    normalizedThreadId.startsWith("gemini:") ||
    normalizedThreadId.startsWith("gemini-pending-")
  ) {
    return "gemini";
  }
  if (
    normalizedThreadId.startsWith("opencode:") ||
    normalizedThreadId.startsWith("opencode-pending-")
  ) {
    return "opencode";
  }
  if (
    normalizedThreadId.startsWith("codex:") ||
    normalizedThreadId.startsWith("codex-pending-")
  ) {
    return "codex";
  }

  return null;
}

function resolveActiveConversationEngine(
  activeThreadSummary: ThreadSummary | null,
  activeThreadId: string | null,
  selectedEngine: EngineType | undefined,
): ConversationEngine {
  const threadEngine =
    activeThreadSummary?.selectedEngine ??
    activeThreadSummary?.engineSource ??
    inferConversationEngineFromThreadId(activeThreadId);
  return toConversationEngine(threadEngine ?? selectedEngine);
}

function flattenLayoutNodesOptions(
  options: LayoutNodesOptions,
): LayoutNodesFlatOptions {
  return {
    ...options.workspace,
    ...options.runtime,
    ...options.chrome,
    ...options.editor,
    ...options.git,
    ...options.composer,
    ...options.panels,
  };
}

export function useLayoutNodes(input: LayoutNodesOptions): LayoutNodesResult {
  const options = flattenLayoutNodesOptions(input);
  const { t } = useTranslation();
  const clientUiVisibility = useClientUiVisibility();
  const onOpenFile = options.onOpenFile;
  const [preferredDockStatusTab, setPreferredDockStatusTab] = useState<{
    tab: TabType;
    requestKey: number;
  } | null>(null);
  const [rewindDialogRequest, setRewindDialogRequest] =
    useState<ComposerRewindDialogRequest | null>(null);
  const [forkConfirmUserMessageId, setForkConfirmUserMessageId] = useState<
    string | null
  >(null);
  const [codexProviderProfiles, setCodexProviderProfiles] = useState<
    CodexProviderProfileOption[]
  >([]);
  const rewindDialogRequestSerialRef = useRef(0);
  const activeThreadStatus = options.activeThreadId
    ? (options.threadStatusById[options.activeThreadId] ?? null)
    : null;
  const activeThreadSummary =
    options.activeWorkspaceId && options.activeThreadId
      ? ((options.threadsByWorkspace[options.activeWorkspaceId] ?? []).find(
          (thread) => thread.id === options.activeThreadId,
        ) ?? null)
      : null;
  const activeProviderProfileLabel = activeThreadSummary
    ? resolveCodexProviderLabel(activeThreadSummary)
    : null;
  useEffect(() => {
    let cancelled = false;
    getCodexProviders()
      .then((providers) => {
        if (cancelled) {
          return;
        }
        setCodexProviderProfiles(
          providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            source: "managed",
          })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setCodexProviderProfiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const historyRestoredAtMsByThread = options.historyRestoredAtMsByThread ?? {};
  const activeHistoryRestoredAtMs = options.activeThreadId
    ? (historyRestoredAtMsByThread[options.activeThreadId] ?? null)
    : null;
  const activeThreadHistoryLoading = options.activeThreadId
    ? options.historyLoadingByThreadId[options.activeThreadId] === true
    : false;
  const showMessageAnchors =
    options.showMessageAnchors &&
    clientUiVisibility.isControlVisible("cornerStatus.messageAnchors");
  const showTopSessionTabs =
    clientUiVisibility.isPanelVisible("topSessionTabs");
  const showTopRunControls =
    clientUiVisibility.isControlVisible("topRun.start");
  const showOpenWorkspaceAppControl = clientUiVisibility.isControlVisible(
    "topTool.openWorkspace",
  );
  const showRightActivityToolbar = clientUiVisibility.isPanelVisible(
    "rightActivityToolbar",
  );
  const rightToolbarVisibleTabs = {
    activity: clientUiVisibility.isControlVisible("rightToolbar.activity"),
    projectMap: clientUiVisibility.isControlVisible("rightToolbar.projectMap"),
    radar: clientUiVisibility.isControlVisible("rightToolbar.radar"),
    git: clientUiVisibility.isControlVisible("rightToolbar.git"),
    files: clientUiVisibility.isControlVisible("rightToolbar.files"),
    search: clientUiVisibility.isControlVisible("rightToolbar.search"),
    notes: clientUiVisibility.isControlVisible("rightToolbar.notes"),
  };
  const hasVisibleRightToolbarControl = Object.values(
    rightToolbarVisibleTabs,
  ).some(Boolean);
  const showBottomActivityPanel = clientUiVisibility.isPanelVisible(
    "bottomActivityPanel",
  );
  const showGlobalRuntimeNoticeDock = clientUiVisibility.isPanelVisible(
    "globalRuntimeNoticeDock",
  );
  const bottomActivityVisibleTabs = {
    realtimeStats: true,
    todo: clientUiVisibility.isControlVisible("bottomActivity.tasks"),
    subagent: clientUiVisibility.isControlVisible("bottomActivity.agents"),
    checkpoint: clientUiVisibility.isControlVisible(
      "bottomActivity.checkpoint",
    ),
    latestUserMessage: clientUiVisibility.isControlVisible(
      "bottomActivity.latestConversation",
    ),
  };
  const shellRuntimeSummary = useMemo(
    () =>
      buildShellRuntimeSummary({
        activeWorkspaceId: options.activeWorkspaceId,
        activeThreadId: options.activeThreadId,
        activeItems: options.activeItems,
        activeThreadStatus,
      }),
    [
      activeThreadStatus,
      options.activeItems,
      options.activeThreadId,
      options.activeWorkspaceId,
    ],
  );
  const isThreadThinking = shellRuntimeSummary.isActiveThreadProcessing;
  const fileRenderPressure = useMemo(
    () => ({
      engineProcessing: isThreadThinking,
      editorSplitChatVisible:
        options.centerMode === "editor" && !options.isEditorFileMaximized,
      activeSurface: "editor" as const,
    }),
    [isThreadThinking, options.centerMode, options.isEditorFileMaximized],
  );
  const conversationEngine = useMemo(
    () =>
      resolveActiveConversationEngine(
        activeThreadSummary,
        options.activeThreadId,
        options.selectedEngine,
      ),
    [activeThreadSummary, options.activeThreadId, options.selectedEngine],
  );
  // Keep heartbeatPulse in a ref so conversationState doesn't change
  // on every heartbeat tick — heartbeat only affects WorkingIndicator
  // which receives it as a separate prop via Messages.
  const heartbeatPulseRef = useRef(activeThreadStatus?.heartbeatPulse ?? null);
  heartbeatPulseRef.current = activeThreadStatus?.heartbeatPulse ?? null;
  const conversationItems = useMemo(
    () =>
      appendQueuedHandoffBubbleIfNeeded(
        options.activeItems,
        options.activeQueuedHandoffBubble,
      ),
    [options.activeItems, options.activeQueuedHandoffBubble],
  );
  const backgroundRenderGatingEnabled = isBackgroundRenderGatingEnabled();
  // 2026-06-24-harden-realtime-interaction-jank-during-tool-call §7.1
  // Accumulate background items across 3 rAF frames before exposing them to
  // non-active threads. Active thread switching (via `resetKey`) drains
  // immediately so the new active thread renders without a multi-frame lag.
  const threadItemsAccumulator = useDeferredFrameAccumulator<typeof options.threadItemsByThread>({
    value: options.threadItemsByThread,
    framesToAccumulate: 3,
    resetKey: options.activeThreadId ?? null,
  });
  const deferredThreadItemsByThreadValue = useDeferredValue(
    threadItemsAccumulator.committed,
  );
  const deferredThreadStatusByIdValue = useDeferredValue(
    options.threadStatusById,
  );
  const deferredStatusPanelItemsValue = useDeferredValue(options.activeItems);
  const statusPanelItems = options.isProcessing
    ? deferredStatusPanelItemsValue
    : options.activeItems;
  const deferredThreadItemsByThread = backgroundRenderGatingEnabled
    ? deferredThreadItemsByThreadValue
    : options.threadItemsByThread;
  const deferredThreadStatusById = backgroundRenderGatingEnabled
    ? deferredThreadStatusByIdValue
    : options.threadStatusById;
  const conversationState = useMemo<ConversationState>(
    () => ({
      items: conversationItems,
      plan: options.plan,
      userInputQueue: options.userInputRequests,
      meta: {
        workspaceId: options.activeWorkspace?.id ?? "",
        threadId: options.activeThreadId ?? "",
        engine: conversationEngine,
        activeTurnId: options.activeTurnId ?? null,
        isThinking: activeThreadStatus?.isProcessing ?? false,
        heartbeatPulse: heartbeatPulseRef.current,
        historyRestoredAtMs: activeHistoryRestoredAtMs,
      },
    }),
    [
      conversationItems,
      options.plan,
      options.userInputRequests,
      options.activeWorkspace?.id,
      options.activeThreadId,
      options.activeTurnId,
      conversationEngine,
      activeThreadStatus?.isProcessing,
      activeHistoryRestoredAtMs,
    ],
  );
  const presentationProfile = useMemo(
    () =>
      options.usePresentationProfile
        ? resolvePresentationProfile(conversationEngine)
        : null,
    [options.usePresentationProfile, conversationEngine],
  );
  const activeWorkspacePath = options.activeWorkspace?.path ?? null;
  const gitDiffItems = options.gitDiffs;
  const canonicalGitPanelChanges = useMemo(
    () =>
      buildCanonicalGitChanges({
        files: options.gitStatus.files,
        stagedFiles: options.gitStatus.stagedFiles,
        unstagedFiles: options.gitStatus.unstagedFiles,
        diffs: options.gitDiffs,
      }),
    [
      options.gitDiffs,
      options.gitStatus.files,
      options.gitStatus.stagedFiles,
      options.gitStatus.unstagedFiles,
    ],
  );
  const canonicalGitPanelTotals = useMemo(
    () => ({
      additions: [
        ...canonicalGitPanelChanges.stagedFiles,
        ...canonicalGitPanelChanges.unstagedFiles,
      ].reduce((total, file) => total + file.additions, 0),
      deletions: [
        ...canonicalGitPanelChanges.stagedFiles,
        ...canonicalGitPanelChanges.unstagedFiles,
      ].reduce((total, file) => total + file.deletions, 0),
    }),
    [
      canonicalGitPanelChanges.stagedFiles,
      canonicalGitPanelChanges.unstagedFiles,
    ],
  );
  const onGitDiffListViewChange = options.onGitDiffListViewChange;
  const onSelectDiff = options.onSelectDiff;
  const handleOpenDiffPath = useCallback(
    (path: string) => {
      const availablePaths = gitDiffItems.map((entry) =>
        entry.path
          .replace(/\\/g, "/")
          .replace(/^\.\/+/, "")
          .trim(),
      );
      const resolvedPath = resolveDiffPathFromWorkspacePath(
        path,
        availablePaths,
        activeWorkspacePath,
      );
      onGitDiffListViewChange("tree");
      onSelectDiff(resolvedPath ?? null);
    },
    [gitDiffItems, activeWorkspacePath, onGitDiffListViewChange, onSelectDiff],
  );
  const workspaceActivity = useWorkspaceSessionActivity({
    activeThreadId: options.activeThreadId,
    threads: options.activeWorkspaceId
      ? (options.threadsByWorkspace[options.activeWorkspaceId] ?? [])
      : [],
    itemsByThread: deferredThreadItemsByThread,
    threadParentById: options.threadParentById,
    threadStatusById: deferredThreadStatusById,
  });
  const isEditorFileMaximized = options.isEditorFileMaximized;
  const onToggleEditorFileMaximized = options.onToggleEditorFileMaximized;
  const handleOpenDiffFromActivity = useCallback(
    (
      path: string,
      location?: EditorNavigationLocation,
      highlightOptions?: OpenFileOptions,
    ) => {
      onOpenFile(path, location, highlightOptions);
      if (!isEditorFileMaximized) {
        onToggleEditorFileMaximized();
      }
    },
    [isEditorFileMaximized, onOpenFile, onToggleEditorFileMaximized],
  );
  const handleOpenProjectMapEvidenceFile = useCallback(
    (path: string, location?: EditorNavigationLocation) => {
      onOpenFile(path, location, { editorSplitCompanion: "projectMap" });
      if (isEditorFileMaximized) {
        onToggleEditorFileMaximized();
      }
    },
    [isEditorFileMaximized, onOpenFile, onToggleEditorFileMaximized],
  );
  const groupedWorkspacesForHeader = useMemo(() => {
    return buildWorkspaceHeaderGroups(
      options.groupedWorkspaces,
      options.workspaces,
    );
  }, [options.groupedWorkspaces, options.workspaces]);

  const { contextMenuNode: topbarTabContextMenuNode, sessionTabsNode } =
    useLayoutTopbarSessionTabs({
      activeThreadId: options.activeThreadId,
      activeWorkspaceId: options.activeWorkspaceId,
      closeCurrentSessionShortcut: options.closeCurrentSessionShortcut,
      cycleOpenSessionNextShortcut: options.cycleOpenSessionNextShortcut,
      cycleOpenSessionPrevShortcut: options.cycleOpenSessionPrevShortcut,
      isPhone: options.isPhone,
      isTablet: options.isTablet,
      showTopSessionTabs,
      threadStatusById: options.threadStatusById,
      threadsByWorkspace: options.threadsByWorkspace,
      t,
      onSelectThread: options.onSelectThread,
      onSelectWorkspace: options.onSelectWorkspace,
    });
  const handleRuntimeProfileRender = useCallback<ProfilerOnRenderCallback>(
    (id) => {
      threadsRuntimeProfile.recordComponentRender(id);
    },
    [],
  );
  const globalRuntimeNoticeDock = useGlobalRuntimeNoticeDock(
    options.workspaces,
  );
  const globalRuntimeNoticeDockNode = showGlobalRuntimeNoticeDock ? (
    <GlobalRuntimeNoticeDock
      notices={globalRuntimeNoticeDock.notices}
      visibility={globalRuntimeNoticeDock.visibility}
      status={globalRuntimeNoticeDock.status}
      onExpand={globalRuntimeNoticeDock.expand}
      onMinimize={globalRuntimeNoticeDock.minimize}
      onClear={globalRuntimeNoticeDock.clear}
    />
  ) : null;
  const sidebarRuntimeNoticeDockNode = options.isPhone ? null : globalRuntimeNoticeDockNode;
  const appRuntimeNoticeDockNode = options.isPhone ? globalRuntimeNoticeDockNode : null;
  const sidebarActiveItems = shellRuntimeSummary.sidebarSubagentItems;
  const canCopyActiveThread = shellRuntimeSummary.canCopyActiveThread;

  const sidebarNode = (
    <Profiler id="sidebar" onRender={handleRuntimeProfileRender}>
      <Sidebar
        workspaces={options.workspaces}
        groupedWorkspaces={options.groupedWorkspaces}
        hasWorkspaceGroups={options.hasWorkspaceGroups}
        deletingWorktreeIds={options.deletingWorktreeIds}
        threadsByWorkspace={options.threadsByWorkspace}
        activeItems={sidebarActiveItems}
        threadParentById={options.threadParentById}
        threadStatusById={options.threadStatusById}
        runningSessionCountByWorkspaceId={
          options.runningSessionCountByWorkspaceId
        }
        recentSessionCountByWorkspaceId={
          options.recentCompletedSessionCountByWorkspaceId
        }
        hydratedThreadListWorkspaceIds={options.hydratedThreadListWorkspaceIds}
        threadListLoadingByWorkspace={options.threadListLoadingByWorkspace}
        threadListPagingByWorkspace={options.threadListPagingByWorkspace}
        threadListCursorByWorkspace={options.threadListCursorByWorkspace}
        activeWorkspaceId={options.activeWorkspaceId}
        activeThreadId={options.activeThreadId}
        systemProxyEnabled={options.systemProxyEnabled}
        systemProxyUrl={options.systemProxyUrl}
        accountRateLimits={options.activeRateLimits}
        usageShowRemaining={options.usageShowRemaining}
        showProviderLabels={options.showSidebarProviderLabels}
        accountInfo={options.accountInfo}
        onSwitchAccount={options.onSwitchAccount}
        onCancelSwitchAccount={options.onCancelSwitchAccount}
        accountSwitching={options.accountSwitching}
        onOpenSettings={options.onOpenSettings}
        onOpenDebug={options.onOpenDebug}
        showDebugButton={options.showDebugButton}
        onAddWorkspace={options.onAddWorkspace}
        onSelectHome={options.onSelectHome}
        onSelectWorkspace={options.onSelectWorkspace}
        onConnectWorkspace={options.onConnectWorkspace}
        onAddAgent={options.onAddAgent}
        engineOptions={options.engineOptions}
        enabledEngines={options.enabledEngines}
        onRefreshEngineOptions={options.onRefreshEngineOptions}
        onAddSharedAgent={options.onAddSharedAgent}
        onAddWorktreeAgent={options.onAddWorktreeAgent}
        onAddCloneAgent={options.onAddCloneAgent}
        onToggleWorkspaceCollapse={options.onToggleWorkspaceCollapse}
        onSelectThread={options.onSelectThread}
        onDeleteThread={options.onDeleteThread}
        onArchiveThread={options.onArchiveThread}
        deleteConfirmThreadId={options.deleteConfirmThreadId}
        deleteConfirmWorkspaceId={options.deleteConfirmWorkspaceId}
        deleteConfirmBusy={options.deleteConfirmBusy}
        onCancelDeleteConfirm={options.onCancelDeleteConfirm}
        onConfirmDeleteConfirm={options.onConfirmDeleteConfirm}
        onSyncThread={options.onSyncThread}
        pinThread={options.pinThread}
        unpinThread={options.unpinThread}
        isThreadPinned={options.isThreadPinned}
        isThreadAutoNaming={options.isThreadAutoNaming}
        getPinTimestamp={options.getPinTimestamp}
        pinnedThreadsVersion={options.pinnedThreadsVersion}
        onRenameThread={options.onRenameThread}
        onAutoNameThread={options.onAutoNameThread}
        onOpenClaudeTui={options.onOpenClaudeTui}
        onDeleteWorkspace={options.onDeleteWorkspace}
        onDeleteWorktree={options.onDeleteWorktree}
        onRenameWorkspaceAlias={options.onRenameWorkspaceAlias}
        onLoadOlderThreads={options.onLoadOlderThreads}
        onReloadWorkspaceThreads={options.onReloadWorkspaceThreads}
        onQuickReloadWorkspaceThreads={options.onQuickReloadWorkspaceThreads}
        workspaceDropTargetRef={options.workspaceDropTargetRef}
        isWorkspaceDropActive={options.isWorkspaceDropActive}
        workspaceDropText={options.workspaceDropText}
        onWorkspaceDragOver={options.onWorkspaceDragOver}
        onWorkspaceDragEnter={options.onWorkspaceDragEnter}
        onWorkspaceDragLeave={options.onWorkspaceDragLeave}
        onWorkspaceDrop={options.onWorkspaceDrop}
        appMode={options.appMode}
        onAppModeChange={options.onAppModeChange}
        onOpenHomeChat={options.onOpenHomeChat}
        onLockPanel={options.onLockPanel}
        onOpenProjectMemory={options.onOpenProjectMemory}
        onOpenReleaseNotes={options.onOpenReleaseNotes}
        onOpenGlobalSearch={options.onOpenGlobalSearch}
        globalSearchShortcut={options.globalSearchShortcut}
        openChatShortcut={options.openChatShortcut}
        openKanbanShortcut={options.openKanbanShortcut}
        showLoadingProgressDialog={options.showLoadingProgressDialog}
        hideLoadingProgressDialog={options.hideLoadingProgressDialog}
        onOpenSpecHub={options.onOpenSpecHub}
        onOpenWorkspaceHome={options.onOpenWorkspaceHome}
        showTerminalButton={options.showTerminalButton}
        isTerminalOpen={options.terminalOpen}
        onToggleTerminal={options.onToggleTerminal}
        runtimeNoticeDockNode={sidebarRuntimeNoticeDockNode}
      />
    </Profiler>
  );

  const [localClaudeThinkingVisible, setLocalClaudeThinkingVisible] = useState<
    boolean | undefined
  >(undefined);
  const reportedClaudeThinkingVisibleRef = useRef<boolean | undefined>(
    typeof options.claudeThinkingVisible === "boolean"
      ? options.claudeThinkingVisible
      : undefined,
  );
  const [selectedCodeAnnotations, setSelectedCodeAnnotations] = useState<
    CodeAnnotationSelection[]
  >([]);
  const handleCreateCodeAnnotation = useCallback(
    (annotation: CodeAnnotationDraftInput) => {
      const selection = createCodeAnnotationSelection(annotation);
      const dedupeKey = buildCodeAnnotationDedupeKey(annotation);
      if (!selection || !dedupeKey) {
        return;
      }
      setSelectedCodeAnnotations((current) => {
        const existingIndex = current.findIndex(
          (entry) => buildCodeAnnotationDedupeKey(entry) === dedupeKey,
        );
        if (existingIndex === -1) {
          return [...current, selection];
        }
        return current.map((entry, index) =>
          index === existingIndex ? selection : entry,
        );
      });
    },
    [],
  );
  const handleRemoveCodeAnnotation = useCallback((annotationId: string) => {
    setSelectedCodeAnnotations((current) =>
      current.filter((entry) => entry.id !== annotationId),
    );
  }, []);
  const handleClearCodeAnnotations = useCallback(() => {
    setSelectedCodeAnnotations((current) =>
      current.length === 0 ? current : [],
    );
  }, []);
  const codeAnnotationBridgeProps = useMemo<CodeAnnotationBridgeProps>(
    () => ({
      onCreateCodeAnnotation: handleCreateCodeAnnotation,
      onRemoveCodeAnnotation: handleRemoveCodeAnnotation,
      codeAnnotations: selectedCodeAnnotations,
    }),
    [
      handleCreateCodeAnnotation,
      handleRemoveCodeAnnotation,
      selectedCodeAnnotations,
    ],
  );
  useEffect(() => {
    setSelectedCodeAnnotations((current) =>
      current.length === 0 ? current : [],
    );
  }, [options.activeThreadId, options.activeWorkspace?.id]);
  const claudeThinkingVisible =
    typeof options.claudeThinkingVisible === "boolean"
      ? options.claudeThinkingVisible
      : localClaudeThinkingVisible;
  useEffect(() => {
    if (typeof options.claudeThinkingVisible === "boolean") {
      reportedClaudeThinkingVisibleRef.current = options.claudeThinkingVisible;
    }
  }, [options.claudeThinkingVisible]);
  const onResolvedClaudeThinkingVisibleChange =
    options.onResolvedClaudeThinkingVisibleChange;
  const handleResolvedAlwaysThinkingChange = useCallback(
    (enabled: boolean) => {
      if (reportedClaudeThinkingVisibleRef.current === enabled) {
        return;
      }
      reportedClaudeThinkingVisibleRef.current = enabled;
      setLocalClaudeThinkingVisible((previous) =>
        previous === enabled ? previous : enabled,
      );
      onResolvedClaudeThinkingVisibleChange?.(enabled);
    },
    [onResolvedClaudeThinkingVisibleChange],
  );
  const onForkFromMessage = options.onForkFromMessage;
  const handleOpenForkConfirmFromMessage = useCallback((messageId: string) => {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return;
    }
    setForkConfirmUserMessageId(normalizedMessageId);
  }, []);
  const handleCancelForkConfirm = useCallback(() => {
    setForkConfirmUserMessageId(null);
  }, []);
  const handleConfirmForkFromMessage = useCallback(
    async (messageId: string, options?: CodexProviderProfileSelection) => {
      await onForkFromMessage?.(messageId, options);
    },
    [onForkFromMessage],
  );
  const codexForkProviderProfiles = useMemo<
    CodexProviderProfileOption[]
  >(() => {
    const profilesById = new Map<string, CodexProviderProfileOption>();
    for (const profile of codexProviderProfiles) {
      profilesById.set(profile.id, profile);
    }
    const activeProviderId =
      activeThreadSummary?.providerProfileId?.trim() ||
      CODEX_DISK_PROVIDER_PROFILE_ID;
    if (
      activeProviderId !== CODEX_DISK_PROVIDER_PROFILE_ID &&
      !profilesById.has(activeProviderId)
    ) {
      profilesById.set(activeProviderId, {
        id: activeProviderId,
        name:
          activeThreadSummary?.providerProfileName?.trim() || activeProviderId,
        source:
          activeThreadSummary?.providerProfileSource === "managed"
            ? "managed"
            : "disk",
      });
    }
    return Array.from(profilesById.values());
  }, [
    activeThreadSummary?.providerProfileId,
    activeThreadSummary?.providerProfileName,
    activeThreadSummary?.providerProfileSource,
    codexProviderProfiles,
  ]);
  const handleOpenRewindDialogFromMessage = useCallback((messageId: string) => {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return;
    }
    const nextRequestId = rewindDialogRequestSerialRef.current + 1;
    rewindDialogRequestSerialRef.current = nextRequestId;
    setRewindDialogRequest({
      requestId: nextRequestId,
      userMessageId: normalizedMessageId,
    });
  }, []);
  const handleRewindDialogRequestConsumed = useCallback((requestId: number) => {
    setRewindDialogRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);

  const taskRunStore = useTaskRunStore();

  const activeCanvasSnapshot = useMemo<ActiveCanvasSnapshot>(
    () => ({
      activeWorkspaceId: options.activeWorkspaceId,
      activeTurnId: options.activeTurnId ?? null,
      items: options.activeItems,
      threadId: options.activeThreadId ?? null,
      workspaceId: options.activeWorkspace?.id ?? null,
      workspacePath: options.activeWorkspace?.path ?? null,
      userInputRequests: options.userInputRequests,
      approvals: options.approvals,
      conversationState,
      plan: options.plan,
      isThinking: isThreadThinking,
      isHistoryLoading: activeThreadHistoryLoading,
      isContextCompacting: activeThreadStatus?.isContextCompacting ?? false,
      processingStartedAt: activeThreadStatus?.processingStartedAt ?? null,
      lastDurationMs: activeThreadStatus?.lastDurationMs ?? null,
      heartbeatPulse: heartbeatPulseRef.current ?? 0,
      codexSilentSuspectedAt:
        activeThreadStatus?.codexSilentSuspectedAt ?? null,
      taskRuns: taskRunStore.runs,
      threadItemsByThread: options.threadItemsByThread,
      threadStatusById: options.threadStatusById,
      activeThreadStatus,
      activeTokenUsage: options.activeTokenUsage,
      activeRateLimits: options.activeRateLimits,
    }),
    [
      options.activeWorkspaceId,
      options.activeTurnId,
      options.activeItems,
      options.activeThreadId,
      options.activeWorkspace?.id,
      options.activeWorkspace?.path,
      options.userInputRequests,
      options.approvals,
      conversationState,
      options.plan,
      isThreadThinking,
      activeThreadHistoryLoading,
      activeThreadStatus,
      taskRunStore.runs,
      options.threadItemsByThread,
      options.threadStatusById,
      options.activeTokenUsage,
      options.activeRateLimits,
    ],
  );

  useLayoutEffect(() => {
    setActiveCanvasSnapshot(activeCanvasSnapshot);
  }, [activeCanvasSnapshot]);

  const messagesNode = useMemo(
    () =>
      buildConversationCanvasNode({
        messagesProps: {
          items: EMPTY_ACTIVE_CANVAS_ITEMS,
          threadId: null,
          workspaceId: null,
          workspacePath: null,
          openTargets: options.openAppTargets,
          selectedOpenAppId: options.selectedOpenAppId,
          showMessageAnchors,
          codeBlockCopyUseModifier: options.codeBlockCopyUseModifier,
          userInputRequests: [],
          approvals: [],
          workspaces: options.workspaces,
          onUserInputSubmit: options.handleUserInputSubmit,
          onUserInputDismiss: options.handleUserInputDismiss,
          onRecoverThreadRuntime: options.onRecoverThreadRuntime,
          onRecoverThreadRuntimeAndResend:
            options.onRecoverThreadRuntimeAndResend,
          onThreadRecoveryFork: options.onThreadRecoveryFork,
          onForkFromMessage: onForkFromMessage
            ? handleOpenForkConfirmFromMessage
            : undefined,
          onRewindFromMessage: options.onRewind
            ? handleOpenRewindDialogFromMessage
            : undefined,
          onApprovalDecision: options.handleApprovalDecision,
          onApprovalBatchAccept: options.handleApprovalBatchAccept,
          onApprovalRemember: options.handleApprovalRemember,
          conversationState: null,
          presentationProfile,
          activeEngine: conversationEngine,
          claudeThinkingVisible,
          activeCollaborationModeId: options.selectedCollaborationModeId,
          plan: null,
          isPlanMode: options.isPlanMode,
          isPlanProcessing: false,
          onOpenDiffPath: handleOpenDiffPath,
          onOpenPlanPanel: options.onOpenPlanPanel,
          onExitPlanModeExecute: options.handleExitPlanModeExecute,
          onOpenWorkspaceFile: options.onOpenFile,
          agentTaskScrollRequest: options.agentTaskScrollRequest,
          isThinking: false,
          isHistoryLoading: false,
          isContextCompacting: false,
          proxyEnabled: options.systemProxyEnabled,
          proxyUrl: options.systemProxyUrl,
          processingStartedAt: null,
          lastDurationMs: null,
          heartbeatPulse: 0,
          codexSilentSuspectedAt: null,
          taskRuns: EMPTY_ACTIVE_CANVAS_TASK_RUNS,
        },
        forkConfirmDialogProps: {
          userMessageId: forkConfirmUserMessageId,
          onCancel: handleCancelForkConfirm,
          onConfirm: handleConfirmForkFromMessage,
          showProviderSelector: conversationEngine === "codex",
          defaultProviderProfileId:
            activeThreadSummary?.providerProfileId ??
            CODEX_DISK_PROVIDER_PROFILE_ID,
          providerProfiles: codexForkProviderProfiles,
        },
      }),
    [
      options.systemProxyEnabled,
      options.systemProxyUrl,
      options.openAppTargets,
      options.selectedOpenAppId,
      showMessageAnchors,
      options.codeBlockCopyUseModifier,
      options.workspaces,
      options.handleUserInputSubmit,
      options.handleUserInputDismiss,
      options.onRecoverThreadRuntime,
      options.onRecoverThreadRuntimeAndResend,
      options.onThreadRecoveryFork,
      onForkFromMessage,
      handleOpenForkConfirmFromMessage,
      forkConfirmUserMessageId,
      handleCancelForkConfirm,
      handleConfirmForkFromMessage,
      activeThreadSummary?.providerProfileId,
      codexForkProviderProfiles,
      options.onRewind,
      handleOpenRewindDialogFromMessage,
      options.handleApprovalDecision,
      options.handleApprovalBatchAccept,
      options.handleApprovalRemember,
      presentationProfile,
      conversationEngine,
      claudeThinkingVisible,
      options.selectedCollaborationModeId,
      options.isPlanMode,
      handleOpenDiffPath,
      options.onOpenPlanPanel,
      options.handleExitPlanModeExecute,
      options.onOpenFile,
      options.agentTaskScrollRequest,
      // heartbeatPulse removed from deps — uses ref to avoid
      // recreating messagesNode on every heartbeat tick
    ],
  );

  const composerSelectedAgent = useMemo(
    () =>
      options.selectedAgent
        ? {
            id: options.selectedAgent.id,
            name: options.selectedAgent.name,
            prompt: options.selectedAgent.prompt ?? undefined,
            icon: options.selectedAgent.icon ?? undefined,
          }
        : null,
    [options.selectedAgent],
  );
  const composerCommands = options.commands ?? EMPTY_COMMANDS;
  const isStatusPanelEngine =
    options.selectedEngine === "claude" ||
    options.selectedEngine === "codex" ||
    options.selectedEngine === "gemini" ||
    options.selectedEngine === "opencode";
  const isStatusPanelCodexEngine = options.selectedEngine === "codex";
  const { todoTotal, subagentTotal, fileChanges, commandTotal } =
    useStatusPanelData(statusPanelItems, {
      isCodexEngine: isStatusPanelCodexEngine,
      activeThreadId: options.activeThreadId,
      itemsByThread: deferredThreadItemsByThread,
      threadParentById: options.threadParentById,
      threadStatusById: deferredThreadStatusById,
    });
  const hasStatusPanelActivity =
    todoTotal > 0 ||
    subagentTotal > 0 ||
    fileChanges.length > 0 ||
    commandTotal > 0 ||
    options.isPlanMode ||
    Boolean(options.plan);
  const hasVisibleBaselineStatusTab =
    bottomActivityVisibleTabs.realtimeStats ||
    bottomActivityVisibleTabs.latestUserMessage ||
    bottomActivityVisibleTabs.checkpoint;
  const shouldMountBottomStatusPanel =
    showBottomActivityPanel &&
    isStatusPanelEngine &&
    (hasStatusPanelActivity ||
      options.bottomStatusPanelExpanded ||
      hasVisibleBaselineStatusTab);
  const showBottomStatusPanel =
    shouldMountBottomStatusPanel && options.bottomStatusPanelExpanded;
  const openBottomStatusPanel = options.onOpenPlanPanel;
  const handleExpandCheckpointToDock = useCallback(() => {
    openBottomStatusPanel();
    setPreferredDockStatusTab((previous) => ({
      tab: "checkpoint",
      requestKey: (previous?.requestKey ?? 0) + 1,
    }));
  }, [openBottomStatusPanel]);
  const composerRuntimeLifecycleState = resolveRuntimeLifecycleForComposer(
    globalRuntimeNoticeDock.runtimeRows,
    options.activeWorkspaceId,
    options.selectedEngine,
  );
  const handleJumpToUserInputRequest = useCallback(
    (request: RequestUserInputRequest) => {
      if (focusUserInputRequestCard(request)) {
        return;
      }
      dispatchMessageJumpEvent(request.params.item_id);
    },
    [],
  );
  const isSharedSession = activeThreadSummary?.threadKind === "shared";
  const rewindWorkspaceGitState = deriveRewindWorkspaceGitState(
    options.gitStatus,
  );

  const renderComposerNode = (showStatusPanelToggleOverride?: boolean) =>
    options.showComposer ? (
      <Profiler id="composer" onRender={handleRuntimeProfileRender}>
        <ActiveCanvasComposer
          items={EMPTY_ACTIVE_CANVAS_ITEMS}
          activeThreadId={null}
          threadItemsByThread={{}}
          threadParentById={options.threadParentById}
          threadStatusById={{}}
          onSend={options.onSend}
          onQueue={options.onQueue}
          onRequestContextCompaction={options.onRequestContextCompaction}
          onStop={options.onStop}
          completionEmailSelected={options.completionEmailSelected}
          completionEmailDisabled={options.completionEmailDisabled}
          onToggleCompletionEmail={options.onToggleCompletionEmail}
          onRewind={options.onRewind}
          rewindDialogRequest={rewindDialogRequest}
          onRewindDialogRequestConsumed={handleRewindDialogRequestConsumed}
          canStop={options.canStop}
          disabled={options.isReviewing}
          contextUsage={null}
          contextDualViewEnabled={options.contextDualViewEnabled}
          codexAutoCompactionEnabled={options.codexAutoCompactionEnabled}
          codexAutoCompactionThresholdPercent={
            options.codexAutoCompactionThresholdPercent
          }
          onCodexAutoCompactionSettingsChange={
            options.onCodexAutoCompactionSettingsChange
          }
          isContextCompacting={false}
          codexCompactionLifecycleState="idle"
          codexCompactionSource={null}
          codexCompactionCompletedAt={null}
          lastTokenUsageUpdatedAt={null}
          accountRateLimits={null}
          usageShowRemaining={options.usageShowRemaining}
          onRefreshAccountRateLimits={options.onRefreshAccountRateLimits}
          queuedMessages={options.activeQueue}
          userInputRequests={[]}
          onJumpToUserInputRequest={handleJumpToUserInputRequest}
          runtimeLifecycleState={composerRuntimeLifecycleState}
          sendLabel={
            options.composerSendLabel ??
            (options.isProcessing && !options.steerEnabled
              ? t("messages.queue")
              : t("messages.send"))
          }
          steerEnabled={options.steerEnabled}
          isProcessing={options.isProcessing}
          draftText={options.draftText}
          onDraftChange={options.onDraftChange}
          attachedImages={options.activeImages}
          onPickImages={options.onPickImages}
          onAttachImages={options.onAttachImages}
          onRemoveImage={options.onRemoveImage}
          intentCanvasAttachments={options.pendingIntentCanvasDocuments}
          onRemoveIntentCanvasAttachment={options.onRemovePendingIntentCanvas}
          prefillDraft={options.prefillDraft}
          onPrefillHandled={options.onPrefillHandled}
          insertText={options.insertText}
          onInsertHandled={options.onInsertHandled}
          onEditQueued={options.onEditQueued}
          onDeleteQueued={options.onDeleteQueued}
          onFuseQueued={options.onFuseQueued}
          canFuseQueuedMessages={options.canFuseActiveQueue}
          fusingQueuedMessageId={options.activeFusingMessageId}
          collaborationModes={options.collaborationModes}
          collaborationModesEnabled={options.collaborationModesEnabled}
          selectedCollaborationModeId={options.selectedCollaborationModeId}
          onSelectCollaborationMode={options.onSelectCollaborationMode}
          isSharedSession={isSharedSession}
          engines={options.engines}
          selectedEngine={options.selectedEngine}
          providerProfileLabel={activeProviderProfileLabel}
          onSelectEngine={options.onSelectEngine}
          models={options.models}
          providerModelCatalogs={options.providerModelCatalogs}
          selectedModelId={options.selectedModelId}
          onSelectModel={options.onSelectModel}
          reasoningOptions={options.reasoningOptions}
          selectedEffort={options.selectedEffort}
          onSelectEffort={options.onSelectEffort}
          reasoningSupported={options.reasoningSupported}
          onResolvedAlwaysThinkingChange={handleResolvedAlwaysThinkingChange}
          opencodeAgents={options.opencodeAgents}
          selectedOpenCodeAgent={options.selectedOpenCodeAgent}
          onSelectOpenCodeAgent={options.onSelectOpenCodeAgent}
          selectedAgent={composerSelectedAgent}
          onAgentSelect={options.onSelectAgent}
          onOpenAgentSettings={options.onOpenAgentSettings}
          onOpenPromptSettings={options.onOpenPromptSettings}
          onOpenModelSettings={options.onOpenModelSettings}
          onRefreshModelConfig={options.onRefreshModelConfig}
          isModelConfigRefreshing={options.isModelConfigRefreshing}
          opencodeVariantOptions={options.opencodeVariantOptions}
          selectedOpenCodeVariant={options.selectedOpenCodeVariant}
          onSelectOpenCodeVariant={options.onSelectOpenCodeVariant}
          accessMode={options.accessMode}
          onSelectAccessMode={options.onSelectAccessMode}
          skills={options.skills}
          customSkillDirectories={options.customSkillDirectories}
          prompts={options.prompts}
          commands={composerCommands}
          files={options.files}
          directories={options.directories}
          gitignoredFiles={options.gitignoredFiles}
          gitignoredDirectories={options.gitignoredDirectories}
          textareaRef={options.textareaRef}
          historyKey={options.activeWorkspace?.id ?? null}
          editorSettings={options.composerEditorSettings}
          sendShortcut={options.composerSendShortcut}
          textareaHeight={options.textareaHeight}
          onTextareaHeightChange={options.onTextareaHeightChange}
          dictationEnabled={options.dictationEnabled}
          dictationState={options.dictationState}
          dictationLevel={options.dictationLevel}
          onToggleDictation={options.onToggleDictation}
          onOpenDictationSettings={options.onOpenDictationSettings}
          onOpenSkillsSettings={options.onOpenSkillsSettings}
          onOpenExperimentalSettings={options.onOpenExperimentalSettings}
          dictationTranscript={options.dictationTranscript}
          onDictationTranscriptHandled={options.onDictationTranscriptHandled}
          dictationError={options.dictationError}
          onDismissDictationError={options.onDismissDictationError}
          dictationHint={options.dictationHint}
          onDismissDictationHint={options.onDismissDictationHint}
          linkedKanbanPanels={options.composerLinkedKanbanPanels}
          selectedLinkedKanbanPanelId={options.selectedComposerKanbanPanelId}
          onSelectLinkedKanbanPanel={options.onSelectComposerKanbanPanel}
          kanbanContextMode={options.composerKanbanContextMode}
          onKanbanContextModeChange={options.onComposerKanbanContextModeChange}
          onOpenLinkedKanbanPanel={options.onOpenComposerKanbanPanel}
          onOpenContextLedgerMemory={options.onOpenContextLedgerMemory}
          onOpenContextLedgerNote={options.onOpenContextLedgerNote}
          activeFilePath={options.activeComposerFilePath}
          activeFileLineRange={options.activeComposerFileLineRange}
          fileReferenceMode={options.fileReferenceMode}
          activeWorkspaceId={options.activeWorkspaceId}
          activeWorkspaceName={options.activeWorkspace?.name ?? null}
          activeWorkspacePath={options.activeWorkspace?.path ?? null}
          rewindWorkspaceGitState={rewindWorkspaceGitState}
          plan={options.plan}
          isPlanMode={options.isPlanMode}
          onOpenDiffPath={(path) => options.onOpenFile(path)}
          showStatusPanelToggleOverride={showStatusPanelToggleOverride}
          statusPanelExpandedOverride={showBottomStatusPanel}
          onToggleStatusPanelOverride={
            showBottomStatusPanel
              ? options.onClosePlanPanel
              : options.onOpenPlanPanel
          }
          selectedCodeAnnotations={selectedCodeAnnotations}
          onRemoveCodeAnnotation={handleRemoveCodeAnnotation}
          onClearCodeAnnotations={handleClearCodeAnnotations}
          reviewPrompt={options.reviewPrompt}
          onReviewPromptClose={options.onReviewPromptClose}
          onReviewPromptShowPreset={options.onReviewPromptShowPreset}
          onReviewPromptChoosePreset={options.onReviewPromptChoosePreset}
          highlightedPresetIndex={options.highlightedPresetIndex}
          onReviewPromptHighlightPreset={options.onReviewPromptHighlightPreset}
          highlightedBranchIndex={options.highlightedBranchIndex}
          onReviewPromptHighlightBranch={options.onReviewPromptHighlightBranch}
          highlightedCommitIndex={options.highlightedCommitIndex}
          onReviewPromptHighlightCommit={options.onReviewPromptHighlightCommit}
          onReviewPromptKeyDown={options.onReviewPromptKeyDown}
          onReviewPromptSelectBranch={options.onReviewPromptSelectBranch}
          onReviewPromptSelectBranchAtIndex={
            options.onReviewPromptSelectBranchAtIndex
          }
          onReviewPromptConfirmBranch={options.onReviewPromptConfirmBranch}
          onReviewPromptSelectCommit={options.onReviewPromptSelectCommit}
          onReviewPromptSelectCommitAtIndex={
            options.onReviewPromptSelectCommitAtIndex
          }
          onReviewPromptConfirmCommit={options.onReviewPromptConfirmCommit}
          onReviewPromptUpdateCustomInstructions={
            options.onReviewPromptUpdateCustomInstructions
          }
          onReviewPromptConfirmCustom={options.onReviewPromptConfirmCustom}
        />
      </Profiler>
    ) : null;
  const composerNode = renderComposerNode(false);
  const homeComposerNode = renderComposerNode(false);
  const approvalToastsNode = null;

  const updateToastNode = (
    <UpdateToast
      state={options.updaterState}
      onUpdate={options.onUpdate}
      onDismiss={options.onDismissUpdate}
    />
  );

  const errorToastsNode = (
    <ErrorToasts
      toasts={options.errorToasts}
      onDismiss={options.onDismissErrorToast}
    />
  );
  const homeWorkspaceOptions = getHomeWorkspaceOptions(
    options.groupedWorkspaces,
    options.workspaces,
  );

  const homeNode = (
    <HomeChat
      latestAgentRuns={options.latestAgentRuns}
      isLoadingLatestAgents={options.isLoadingLatestAgents}
      onSelectThread={options.onSelectHomeThread}
      workspaces={homeWorkspaceOptions}
      selectedWorkspaceId={resolveHomeWorkspaceId(
        options.activeWorkspace?.id ?? null,
        homeWorkspaceOptions,
      )}
      onSelectWorkspace={options.onSelectHomeWorkspace}
      onAddWorkspace={options.onAddWorkspace}
      composerNode={homeComposerNode}
      selectedEngine={options.selectedEngine}
      selectedBranchName={options.branchName}
    />
  );

  const mainHeaderNode = options.activeWorkspace ? (
    <MainHeader
      workspace={options.activeWorkspace}
      parentName={options.activeParentWorkspace?.name ?? null}
      worktreeLabel={options.worktreeLabel}
      worktreeRename={options.worktreeRename}
      disableBranchMenu={options.isWorktreeWorkspace}
      parentPath={options.activeParentWorkspace?.path ?? null}
      worktreePath={
        options.isWorktreeWorkspace ? options.activeWorkspace.path : null
      }
      openTargets={options.openAppTargets}
      openAppIconById={options.openAppIconById}
      selectedOpenAppId={options.selectedOpenAppId}
      onSelectOpenAppId={options.onSelectOpenAppId}
      branchName={options.branchName}
      branches={options.branches}
      onCheckoutBranch={options.onCheckoutBranch}
      onCreateBranch={options.onCreateBranch}
      sessionTabsNode={sessionTabsNode}
      canCopyThread={canCopyActiveThread}
      onCopyThread={options.onCopyThread}
      onLockPanel={options.onLockPanel}
      launchScript={options.launchScript}
      launchScriptEditorOpen={options.launchScriptEditorOpen}
      launchScriptDraft={options.launchScriptDraft}
      launchScriptSaving={options.launchScriptSaving}
      launchScriptError={options.launchScriptError}
      onRunLaunchScript={options.onRunLaunchScript}
      onOpenLaunchScriptEditor={options.onOpenLaunchScriptEditor}
      onCloseLaunchScriptEditor={options.onCloseLaunchScriptEditor}
      onLaunchScriptDraftChange={options.onLaunchScriptDraftChange}
      onSaveLaunchScript={options.onSaveLaunchScript}
      launchScriptsState={options.launchScriptsState}
      showLaunchScriptControls={showTopRunControls}
      showOpenAppMenu={showOpenWorkspaceAppControl}
      openAppExtraActions={options.mainHeaderActions}
      groupedWorkspaces={groupedWorkspacesForHeader}
      activeWorkspaceId={options.activeWorkspaceId}
      onSelectWorkspace={options.onSelectWorkspace}
    />
  ) : null;

  const desktopTopbarLeftNode = buildDesktopTopbarLeftNode({
    centerMode: options.centerMode,
    backLabel: t("files.backToChat"),
    mainHeaderNode,
    contextMenuNode: topbarTabContextMenuNode,
    onExitDiff: options.onExitDiff,
  });

  const tabletNavNode = (
    <TabletNav
      activeTab={options.tabletNavTab}
      onSelect={options.onSelectTab}
    />
  );

  const tabBarNode = (
    <TabBar activeTab={options.activeTab} onSelect={options.onSelectTab} />
  );
  const activeWorkspaceCustomSpecRoot = useMemo(() => {
    if (!options.activeWorkspace?.id) {
      return null;
    }
    const value = getClientStoreSync<string | null>(
      "app",
      `specHub.specRoot.${options.activeWorkspace.id}`,
    );
    return normalizeSpecRootInput(value);
  }, [options.activeWorkspace?.id]);

  const sidebarSelectedDiffPath =
    options.centerMode === "diff" ? options.selectedDiffPath : null;
  const onFilePanelModeChange = options.onFilePanelModeChange;
  const onOpenProjectMap = options.onOpenProjectMap;
  const onOpenIntentCanvas = options.onOpenIntentCanvas;
  const handleAssociateIntentCanvasCodeAnchor = useCallback(
    async (anchor: IntentCanvasCodeSelectionAnchor) => {
      if (!options.activeWorkspace) {
        pushErrorToast({
          title: "无法关联 Canvas",
          message: "请先选择一个工作区。",
          variant: "info",
          durationMs: 4200,
        });
        return;
      }
      let graph: CanvasSemanticGraph;
      try {
        graph = await loadCodeSelectionRelationshipGraph({
          workspaceId: options.activeWorkspace.id,
          anchor,
          storageLocation:
            options.projectMapDatasetController?.activeReadLocation,
        });
      } catch (error) {
        pushErrorToast({
          title: "无法生成方法关系图",
          message: error instanceof Error ? error.message : String(error),
          variant: "info",
          durationMs: 5200,
        });
        return;
      }
      onOpenIntentCanvas?.({
        mode: "file",
        target: "new",
        title: `${anchor.symbolName} Canvas`,
        summary: `${anchor.symbolKind} ${anchor.symbolName} at ${anchor.filePath}:${anchor.declarationLine}`,
        source: {
          filePath: anchor.filePath,
          nodeTitle: anchor.symbolName,
          nodeKind: anchor.symbolKind,
          summary: `${anchor.symbolKind} ${anchor.symbolName}`,
        },
        seedSemanticGraphs: [graph],
      });
    },
    [
      onOpenIntentCanvas,
      options.activeWorkspace,
      options.projectMapDatasetController?.activeReadLocation,
    ],
  );
  const centerMode = options.centerMode;
  const setCenterMode = options.setCenterMode;
  const editorSplitCompanion = options.editorSplitCompanion;
  const setEditorSplitCompanion = options.setEditorSplitCompanion;
  const isProjectMapSurfaceActive =
    centerMode === "projectMap" ||
    (centerMode === "editor" && editorSplitCompanion === "projectMap");
  const isIntentCanvasSurfaceActive = centerMode === "intentCanvas";

  const handleRightPanelTabSelect = useCallback(
    (tabId: RightPanelTabSelection) => {
      if (tabId === "intentCanvas") {
        if (isIntentCanvasSurfaceActive) {
          setCenterMode("chat");
          return;
        }
        onOpenIntentCanvas?.();
        return;
      }
      if (tabId === "projectMap") {
        if (isProjectMapSurfaceActive) {
          if (centerMode === "editor") {
            setEditorSplitCompanion("chat");
            return;
          }
          setCenterMode("chat");
          return;
        }
        if (centerMode === "editor") {
          setEditorSplitCompanion("projectMap");
          if (isEditorFileMaximized) {
            onToggleEditorFileMaximized();
          }
          return;
        }
        onOpenProjectMap();
        return;
      }
      onFilePanelModeChange(tabId);
    },
    [
      isIntentCanvasSurfaceActive,
      isProjectMapSurfaceActive,
      centerMode,
      onFilePanelModeChange,
      onOpenProjectMap,
      onOpenIntentCanvas,
      isEditorFileMaximized,
      onToggleEditorFileMaximized,
      setCenterMode,
      setEditorSplitCompanion,
    ],
  );

  const rightPanelToolbarNode = buildRightPanelToolbarNode({
    active: isIntentCanvasSurfaceActive
      ? "intentCanvas"
      : isProjectMapSurfaceActive
        ? "projectMap"
        : options.filePanelMode,
    showToolbar: showRightActivityToolbar,
    hasVisibleControl: hasVisibleRightToolbarControl,
    activityLive: workspaceActivity.isProcessing,
    radarLive: options.sessionRadarRunningSessions.length > 0,
    visibleTabs: rightToolbarVisibleTabs,
    onSelect: handleRightPanelTabSelect,
  });

  let gitDiffPanelNode: ReactNode;
  if (options.filePanelMode === "files" && options.activeWorkspace) {
    gitDiffPanelNode = (
      <FileTreePanel
        workspaceId={options.activeWorkspace.id}
        workspaceName={options.activeWorkspace.name}
        workspacePath={options.activeWorkspace.path}
        gitRoot={options.gitRoot}
        files={options.files}
        directories={options.directories}
        directoryMetadata={options.directoryMetadata}
        sourceVersion={options.fileTreeSourceVersion}
        isLoading={options.fileTreeLoading}
        loadError={options.fileTreeLoadError}
        filePanelMode={options.filePanelMode}
        onFilePanelModeChange={options.onFilePanelModeChange}
        onInsertText={options.onInsertComposerText}
        onOpenFile={options.onOpenFile}
        openTargets={options.openAppTargets}
        openAppIconById={options.openAppIconById}
        selectedOpenAppId={options.selectedOpenAppId}
        onSelectOpenAppId={options.onSelectOpenAppId}
        onToggleRuntimeConsole={options.onToggleRuntimeConsole}
        isRuntimeConsoleVisible={options.runtimeConsoleVisible}
        onOpenSpecHub={options.onOpenSpecHub}
        isSpecHubActive={options.activeTab === "spec"}
        onOpenDetachedExplorer={options.onOpenDetachedFileExplorer}
        gitStatusFiles={options.gitStatus.files}
        gitignoredFiles={options.gitignoredFiles}
        gitignoredDirectories={options.gitignoredDirectories}
        onRefreshFiles={options.onRefreshFiles}
      />
    );
  } else if (options.filePanelMode === "search") {
    gitDiffPanelNode = (
      <WorkspaceSearchPanel
        workspaceId={options.activeWorkspace?.id ?? null}
        filePanelMode={options.filePanelMode}
        onFilePanelModeChange={options.onFilePanelModeChange}
        onOpenFile={options.onOpenFile}
      />
    );
  } else if (options.filePanelMode === "notes") {
    gitDiffPanelNode = (
      <WorkspaceNoteCardPanel
        workspaceId={options.activeWorkspace?.id ?? null}
        workspaceName={options.activeWorkspace?.name ?? null}
        workspacePath={options.activeWorkspace?.path ?? null}
        focusNoteId={options.focusedWorkspaceNoteId ?? null}
        focusRequestKey={options.focusedWorkspaceNoteRequestKey ?? 0}
      />
    );
  } else if (options.filePanelMode === "prompts") {
    gitDiffPanelNode = (
      <PromptPanel
        prompts={options.prompts}
        workspacePath={options.activeWorkspace?.path ?? null}
        filePanelMode={options.filePanelMode}
        onFilePanelModeChange={options.onFilePanelModeChange}
        onSendPrompt={options.onSendPrompt}
        onSendPromptToNewAgent={options.onSendPromptToNewAgent}
        onCreatePrompt={options.onCreatePrompt}
        onUpdatePrompt={options.onUpdatePrompt}
        onDeletePrompt={options.onDeletePrompt}
        onMovePrompt={options.onMovePrompt}
        onRevealWorkspacePrompts={options.onRevealWorkspacePrompts}
        onRevealGeneralPrompts={options.onRevealGeneralPrompts}
        canRevealGeneralPrompts={options.canRevealGeneralPrompts}
      />
    );
  } else if (options.filePanelMode === "memory") {
    gitDiffPanelNode = (
      <ProjectMemoryPanel
        workspaceId={options.activeWorkspace?.id ?? null}
        workspaces={options.workspaces}
        onSelectWorkspace={options.onSelectWorkspace}
        filePanelMode={options.filePanelMode}
        onFilePanelModeChange={options.onFilePanelModeChange}
        focusMemoryId={options.focusedProjectMemoryId ?? null}
        focusRequestKey={options.focusedProjectMemoryRequestKey ?? 0}
      />
    );
  } else if (options.filePanelMode === "activity") {
    gitDiffPanelNode = (
      <WorkspaceSessionActivityPanel
        workspaceId={options.activeWorkspace?.id ?? null}
        workspacePath={options.activeWorkspace?.path ?? null}
        viewModel={workspaceActivity}
        onOpenDiffPath={handleOpenDiffFromActivity}
        onSelectThread={options.onSelectThread}
        liveEditPreviewEnabled={options.liveEditPreviewEnabled}
        onToggleLiveEditPreview={options.onToggleLiveEditPreview}
        onRefreshGitStatus={options.queueGitStatusRefresh}
        {...codeAnnotationBridgeProps}
      />
    );
  } else if (options.filePanelMode === "radar") {
    gitDiffPanelNode = (
      <WorkspaceSessionRadarPanel
        runningSessions={options.sessionRadarRunningSessions}
        recentCompletedSessions={options.sessionRadarRecentCompletedSessions}
        onSelectThread={options.onSelectThread}
      />
    );
  } else {
    gitDiffPanelNode = (
      <Suspense fallback={<HeavyPanelFallback />}>
        <GitDiffPanel
          workspaceId={options.activeWorkspace?.id ?? null}
          workspacePath={options.activeWorkspace?.path ?? null}
          mode={options.gitPanelMode}
          onModeChange={options.onGitPanelModeChange}
          onOpenGitHistoryPanel={options.onOpenGitHistoryPanel}
          isGitHistoryOpen={options.appMode === "gitHistory"}
          diffEntries={options.gitDiffs}
          gitDiffListView={options.gitDiffListView}
          onGitDiffListViewChange={options.onGitDiffListViewChange}
          toggleGitDiffListViewShortcut={options.toggleGitDiffListViewShortcut}
          filePanelMode={options.filePanelMode}
          onFilePanelModeChange={options.onFilePanelModeChange}
          worktreeApplyLabel={options.worktreeApplyLabel}
          worktreeApplyTitle={options.worktreeApplyTitle}
          worktreeApplyLoading={options.worktreeApplyLoading}
          worktreeApplyError={options.worktreeApplyError}
          worktreeApplySuccess={options.worktreeApplySuccess}
          onApplyWorktreeChanges={options.onApplyWorktreeChanges}
          branchName={
            options.gitStatus.branchName || t("workspace.unknownBranch")
          }
          totalAdditions={canonicalGitPanelTotals.additions}
          totalDeletions={canonicalGitPanelTotals.deletions}
          fileStatus={options.fileStatus}
          diffViewStyle={options.gitDiffViewStyle}
          onDiffViewStyleChange={options.onGitDiffViewStyleChange}
          error={options.gitStatus.error}
          logError={options.gitLogError}
          logLoading={options.gitLogLoading}
          stagedFiles={canonicalGitPanelChanges.stagedFiles}
          unstagedFiles={canonicalGitPanelChanges.unstagedFiles}
          onSelectFile={options.onSelectDiff}
          onOpenFile={options.onOpenFile}
          selectedPath={sidebarSelectedDiffPath}
          logEntries={options.gitLogEntries}
          logTotal={options.gitLogTotal}
          logAhead={options.gitLogAhead}
          logBehind={options.gitLogBehind}
          logAheadEntries={options.gitLogAheadEntries}
          logBehindEntries={options.gitLogBehindEntries}
          logUpstream={options.gitLogUpstream}
          selectedCommitSha={options.selectedCommitSha}
          onSelectCommit={options.onSelectCommit}
          issues={options.gitIssues}
          issuesTotal={options.gitIssuesTotal}
          issuesLoading={options.gitIssuesLoading}
          issuesError={options.gitIssuesError}
          pullRequests={options.gitPullRequests}
          pullRequestsTotal={options.gitPullRequestsTotal}
          pullRequestsLoading={options.gitPullRequestsLoading}
          pullRequestsError={options.gitPullRequestsError}
          selectedPullRequest={options.selectedPullRequestNumber}
          onSelectPullRequest={options.onSelectPullRequest}
          gitRemoteUrl={options.gitRemoteUrl}
          gitRoot={options.gitRoot}
          gitRootCandidates={options.gitRootCandidates}
          gitRootScanDepth={options.gitRootScanDepth}
          gitRootScanLoading={options.gitRootScanLoading}
          gitRootScanError={options.gitRootScanError}
          gitRootScanHasScanned={options.gitRootScanHasScanned}
          onGitRootScanDepthChange={options.onGitRootScanDepthChange}
          onScanGitRoots={options.onScanGitRoots}
          onSelectGitRoot={options.onSelectGitRoot}
          onClearGitRoot={options.onClearGitRoot}
          onPickGitRoot={options.onPickGitRoot}
          onStageAllChanges={options.onStageGitAll}
          onStageFile={options.onStageGitFile}
          onUnstageFile={options.onUnstageGitFile}
          onRevertFile={options.onRevertGitFile}
          onRevertAllChanges={options.onRevertAllGitChanges}
          commitMessage={options.commitMessage}
          commitMessageLoading={options.commitMessageLoading}
          commitMessageError={options.commitMessageError}
          onCommitMessageChange={options.onCommitMessageChange}
          onGenerateCommitMessage={options.onGenerateCommitMessage}
          onCommit={options.onCommit}
          onCommitAndPush={options.onCommitAndPush}
          onCommitAndSync={options.onCommitAndSync}
          onPush={options.onPush}
          onSync={options.onSync}
          commitLoading={options.commitLoading}
          pushLoading={options.pushLoading}
          syncLoading={options.syncLoading}
          commitError={options.commitError}
          pushError={options.pushError}
          syncError={options.syncError}
          commitsAhead={options.commitsAhead}
          onRefreshGitDiffs={options.refreshGitDiffs}
          onCreateCodeAnnotation={handleCreateCodeAnnotation}
          onRemoveCodeAnnotation={handleRemoveCodeAnnotation}
          codeAnnotations={selectedCodeAnnotations}
        />
      </Suspense>
    );
  }

  const gitDiffViewerNode = (
    <GitDiffViewer
      workspaceId={options.activeWorkspace?.id ?? null}
      diffs={options.gitDiffs}
      listView={options.gitDiffListView}
      selectedPath={options.selectedDiffPath}
      scrollRequestId={options.diffScrollRequestId}
      isLoading={options.gitDiffLoading}
      error={options.gitDiffError}
      diffStyle={options.gitDiffViewStyle}
      onDiffStyleChange={options.onGitDiffViewStyleChange}
      pullRequest={options.selectedPullRequest}
      pullRequestComments={options.selectedPullRequestComments}
      pullRequestCommentsLoading={options.selectedPullRequestCommentsLoading}
      pullRequestCommentsError={options.selectedPullRequestCommentsError}
      onActivePathChange={options.onDiffActivePathChange}
      onOpenFile={options.onOpenFile}
      onRequestClose={options.onExitDiff}
      onCreateCodeAnnotation={handleCreateCodeAnnotation}
      onRemoveCodeAnnotation={handleRemoveCodeAnnotation}
      codeAnnotations={selectedCodeAnnotations}
      codeAnnotationSurface="embedded-diff-view"
    />
  );

  const fileViewPanelNode =
    options.editorFilePath && options.activeWorkspace ? (
      <Suspense fallback={<HeavyPanelFallback />}>
        <FileViewPanel
          workspaceId={options.activeWorkspace.id}
          workspaceName={options.activeWorkspace.name}
          workspacePath={options.activeWorkspace.path}
          gitRoot={options.gitRoot}
          customSpecRoot={activeWorkspaceCustomSpecRoot}
          filePath={options.editorFilePath}
          navigationTarget={options.editorNavigationTarget}
          highlightMarkers={
            options.editorHighlightTarget?.path === options.editorFilePath
              ? options.editorHighlightTarget.markers
              : null
          }
          gitStatusFiles={options.gitStatus.files}
          openTabs={options.openEditorTabs}
          activeTabPath={options.editorFilePath}
          onActivateTab={options.onActivateEditorTab}
          onCloseTab={options.onCloseEditorTab}
          onCloseAllTabs={options.onCloseAllEditorTabs}
          fileReferenceMode={options.fileReferenceMode}
          onFileReferenceModeChange={options.onFileReferenceModeChange}
          activeFileLineRange={options.activeComposerFileLineRange}
          onActiveFileLineRangeChange={options.onActiveEditorLineRangeChange}
          onActiveCodeAnchorChange={options.onActiveCodeSelectionAnchorChange}
          onAssociateIntentCanvasCodeAnchor={
            handleAssociateIntentCanvasCodeAnchor
          }
          openTargets={options.openAppTargets}
          openAppIconById={options.openAppIconById}
          selectedOpenAppId={options.selectedOpenAppId}
          onSelectOpenAppId={options.onSelectOpenAppId}
          editorSplitLayout={options.editorSplitLayout}
          onToggleEditorSplitLayout={options.onToggleEditorSplitLayout}
          isEditorFileMaximized={options.isEditorFileMaximized}
          onToggleEditorFileMaximized={options.onToggleEditorFileMaximized}
          onNavigateToLocation={options.onOpenFile}
          onClose={options.onExitEditor}
          onInsertText={options.onInsertComposerText}
          onCreateCodeAnnotation={handleCreateCodeAnnotation}
          onRemoveCodeAnnotation={handleRemoveCodeAnnotation}
          codeAnnotations={selectedCodeAnnotations}
          externalChangeMonitoringEnabled={
            options.externalChangeMonitoringEnabled
          }
          externalChangeTransportMode={options.externalChangeTransportMode}
          externalChangeApplyMode={options.externalChangeApplyMode}
          externalChangeAutoApplyDebounceMs={
            options.externalChangeAutoApplyDebounceMs
          }
          markdownPreviewSnapshotMode={
            options.liveEditPreviewEnabled ? "live" : "stable"
          }
          fileRenderPressure={fileRenderPressure}
          saveFileShortcut={options.saveFileShortcut}
          findInFileShortcut={options.findInFileShortcut}
        />
      </Suspense>
    ) : null;

  const projectMapImpactInput = useMemo(
    () =>
      isProjectMapSurfaceActive
        ? buildGitStatusProjectMapImpactInput(options.gitStatus.files)
        : EMPTY_PROJECT_MAP_IMPACT_INPUT,
    [isProjectMapSurfaceActive, options.gitStatus.files],
  );
  const orchestrationTaskStore = useOrchestrationTaskStore();
  const [isOrchestrationCenterOpen, setIsOrchestrationCenterOpen] =
    useState(false);
  const [selectedOrchestrationTaskId, setSelectedOrchestrationTaskId] =
    useState<string | null>(null);
  const [projectMapSourceFocusNodeId, setProjectMapSourceFocusNodeId] =
    useState<string | null>(null);
  const projectMapDataset =
    options.projectMapDatasetController?.dataset ?? null;
  const projectMapRelationshipContextPack =
    options.projectMapDatasetController?.relationshipContextPack ?? null;
  const orchestrationWorkspaceId =
    options.activeWorkspace?.id ??
    projectMapDataset?.manifest.storageKey ??
    null;
  const persistedOrchestrationTasks = orchestrationTaskStore.tasks;
  const shouldComputeProjectMapOrchestration =
    isProjectMapSurfaceActive || isOrchestrationCenterOpen;
  const [specWorkspaceSnapshot, setSpecWorkspaceSnapshot] =
    useState<SpecWorkspaceSnapshot | null>(null);
  useEffect(() => {
    if (!shouldComputeProjectMapOrchestration || !orchestrationWorkspaceId) {
      setSpecWorkspaceSnapshot(null);
      return;
    }
    let cancelled = false;
    buildSpecWorkspaceSnapshot({
      workspaceId: orchestrationWorkspaceId,
      files: options.files,
      directories: options.directories,
      customSpecRoot: activeWorkspaceCustomSpecRoot,
    })
      .then((snapshot) => {
        if (!cancelled) {
          setSpecWorkspaceSnapshot(snapshot);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(
            "[agent-orchestration] Failed to build SpecHub provider snapshot",
            error,
          );
          setSpecWorkspaceSnapshot(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceCustomSpecRoot,
    orchestrationWorkspaceId,
    options.directories,
    options.files,
    shouldComputeProjectMapOrchestration,
  ]);
  const orchestrationProviderSnapshots = useMemo(() => {
    if (!shouldComputeProjectMapOrchestration || !orchestrationWorkspaceId) {
      return [];
    }
    const coreSnapshots = collectCoreOrchestrationProviderSnapshots({
      workspaceId: orchestrationWorkspaceId,
      projectMapDataset,
      projectMapRelationshipContextPack,
      taskRuns: taskRunStore.runs,
    });
    if (
      !specWorkspaceSnapshot ||
      (specWorkspaceSnapshot.provider === "unknown" &&
        specWorkspaceSnapshot.specRoot?.source !== "custom")
    ) {
      return coreSnapshots;
    }
    return [
      ...coreSnapshots,
      readSpecHubOrchestrationCandidates({
        workspaceId: orchestrationWorkspaceId,
        snapshot: specWorkspaceSnapshot,
      }),
    ];
  }, [
    orchestrationWorkspaceId,
    projectMapDataset,
    projectMapRelationshipContextPack,
    shouldComputeProjectMapOrchestration,
    specWorkspaceSnapshot,
    taskRunStore.runs,
  ]);
  useEffect(() => {
    if (
      orchestrationTaskStore.tasks.length === 0 ||
      taskRunStore.runs.length === 0
    ) {
      return;
    }

    const projectionSignature = buildOrchestrationProjectionSignature(
      orchestrationTaskStore,
      taskRunStore.runs,
    );
    if (lastOrchestrationProjectionSignature === projectionSignature) {
      return;
    }
    lastOrchestrationProjectionSignature = projectionSignature;

    const projectedStore = projectLinkedTaskRunsToOrchestrationStore({
      orchestrationStore: orchestrationTaskStore,
      taskRuns: taskRunStore.runs,
    });
    if (projectedStore !== orchestrationTaskStore) {
      saveOrchestrationTaskStore(projectedStore);
    }
  }, [orchestrationTaskStore, taskRunStore.runs]);
  const handleOpenOrchestrationTask = useCallback((taskId: string) => {
    setSelectedOrchestrationTaskId(taskId);
    setIsOrchestrationCenterOpen(true);
  }, []);
  useEffect(() => {
    const handleOpenOrchestrationTaskEvent = (event: Event) => {
      const taskId = readOpenOrchestrationTaskEvent(event);
      if (taskId) {
        handleOpenOrchestrationTask(taskId);
      }
    };

    window.addEventListener(
      OPEN_ORCHESTRATION_TASK_EVENT,
      handleOpenOrchestrationTaskEvent,
    );
    return () => {
      window.removeEventListener(
        OPEN_ORCHESTRATION_TASK_EVENT,
        handleOpenOrchestrationTaskEvent,
      );
    };
  }, [handleOpenOrchestrationTask]);
  const handleBackToProjectMapFromOrchestration = useCallback(() => {
    setIsOrchestrationCenterOpen(false);
  }, []);
  const handleOpenOrchestrationSourceRef = useCallback(
    (input: { task: OrchestrationTask; sourceRef: OrchestrationSourceRef }) => {
      const { sourceRef } = input;
      if (
        sourceRef.providerId === "project-map" &&
        sourceRef.kind === "project_map_node"
      ) {
        setProjectMapSourceFocusNodeId(sourceRef.id);
        setIsOrchestrationCenterOpen(false);
        return;
      }

      const sourcePath = sourceRef.workspaceRelativePath ?? sourceRef.path;
      if (sourcePath) {
        handleOpenProjectMapEvidenceFile(sourcePath);
      }
    },
    [handleOpenProjectMapEvidenceFile],
  );
  const handleConfirmOrchestrationDispatch = useCallback(
    async (confirmation: OrchestrationDispatchConfirmation) => {
      const result = await options.onDispatchOrchestrationTask?.(confirmation);
      if (result?.taskId) {
        setSelectedOrchestrationTaskId(result.taskId);
      }
    },
    [options],
  );
  const handleCancelOrchestrationRun = useCallback(
    (request: OrchestrationCancelRunRequest) => {
      const now = Date.now();
      const nextTaskRunStore = patchTaskRun(taskRunStore, request.run.runId, {
        status: "canceled",
        currentStep: "canceled_before_runtime_start",
        latestOutputSummary: "Dispatch canceled before runtime start.",
        availableRecoveryActions: ["retry", "fork_new_run"],
        finishedAt: now,
        now,
      });
      const nextOrchestrationTaskStore = patchOrchestrationTask(
        orchestrationTaskStore,
        request.task.taskId,
        {
          status: "planned",
          now: new Date(now).toISOString(),
        },
      );
      saveTaskRunStore(nextTaskRunStore);
      saveOrchestrationTaskStore(nextOrchestrationTaskStore);
      setSelectedOrchestrationTaskId(request.task.taskId);
    },
    [orchestrationTaskStore, taskRunStore],
  );
  const handleOrchestrationReviewAction = useCallback(
    (request: OrchestrationReviewActionRequest) => {
      const result = applyOrchestrationReviewAction(request);
      setSelectedOrchestrationTaskId(
        result.followUpTask?.taskId ?? result.task.taskId,
      );
    },
    [],
  );
  const handleArchiveOrchestrationTask = useCallback(
    (task: OrchestrationTask) => {
      const nextStore = archiveOrchestrationTask(
        orchestrationTaskStore,
        task.taskId,
      );
      saveOrchestrationTaskStore(nextStore);
      setSelectedOrchestrationTaskId(null);
    },
    [orchestrationTaskStore],
  );
  const handleCreateManualOrchestrationTask = useCallback(
    (request: OrchestrationManualTaskDraftRequest) => {
      if (!orchestrationWorkspaceId) {
        return null;
      }
      const task = createManualOrchestrationTaskDraft({
        workspaceId: orchestrationWorkspaceId,
        title: request.title,
        scopeSummary: request.scopeSummary,
        acceptanceSummary: request.acceptanceSummary,
        promptSummary: request.promptSummary || null,
        preferredEngine: request.preferredEngine,
      });
      const nextStore = upsertOrchestrationTask(orchestrationTaskStore, task);
      saveOrchestrationTaskStore(nextStore);
      setSelectedOrchestrationTaskId(task.taskId);
      return task;
    },
    [orchestrationTaskStore, orchestrationWorkspaceId],
  );
  const handleOpenOrchestrationSession = useCallback(
    (_task: OrchestrationTask, sessionId: string) => {
      if (!options.activeWorkspace) {
        return;
      }
      options.onSelectThread(options.activeWorkspace.id, sessionId);
    },
    [options],
  );

  const shouldMountProjectMapPanel =
    isProjectMapSurfaceActive || isOrchestrationCenterOpen;
  const projectMapPanelNode = shouldMountProjectMapPanel ? (
    isOrchestrationCenterOpen ? (
      <OrchestrationCenterView
        key={`${options.activeWorkspace?.id ?? "no-workspace"}:orchestration`}
        workspaceId={orchestrationWorkspaceId}
        workspaceName={options.activeWorkspace?.name ?? null}
        persistedTasks={persistedOrchestrationTasks}
        providerSnapshots={orchestrationProviderSnapshots}
        selectedTaskId={selectedOrchestrationTaskId}
        onOpenSourceRef={handleOpenOrchestrationSourceRef}
        onConfirmDispatch={handleConfirmOrchestrationDispatch}
        onCreateManualTask={handleCreateManualOrchestrationTask}
        onCancelRun={handleCancelOrchestrationRun}
        onReviewAction={handleOrchestrationReviewAction}
        onArchiveTask={handleArchiveOrchestrationTask}
        onOpenSession={handleOpenOrchestrationSession}
        taskRuns={taskRunStore.runs}
        modelOptions={options.models}
        defaultModelId={options.selectedModelId}
        onBackToProjectMap={handleBackToProjectMapFromOrchestration}
      />
    ) : (
      <Suspense fallback={<HeavyPanelFallback />}>
        <ProjectMapPanel
          key={options.activeWorkspace?.id ?? "no-workspace"}
          activeWorkspace={options.activeWorkspace ?? null}
          workspaceName={options.activeWorkspace?.name ?? null}
          selectedEngine={options.selectedEngine ?? null}
          selectedModelId={options.selectedModelId}
          models={options.models}
          datasetController={options.projectMapDatasetController}
          changedFilePaths={projectMapImpactInput.filePaths}
          changedFileSource={projectMapImpactInput.source}
          sourceFocusNodeId={projectMapSourceFocusNodeId}
          activeCodeSelectionAnchor={options.activeCodeSelectionAnchor}
          onOpenEvidenceFile={handleOpenProjectMapEvidenceFile}
          onOpenOrchestrationTask={handleOpenOrchestrationTask}
          onOpenIntentCanvas={options.onOpenIntentCanvas}
          onOpenIntentCanvasFromRelationship={options.onOpenIntentCanvas}
        />
      </Suspense>
    )
  ) : null;

  const intentCanvasPanelNode = isIntentCanvasSurfaceActive ? (
    <Suspense fallback={<HeavyPanelFallback />}>
      <IntentCanvasManager
        activeWorkspace={options.activeWorkspace ?? null}
        activeThreadId={options.activeThreadId ?? null}
        openRequest={options.intentCanvasOpenRequest ?? null}
        onOpenRequestConsumed={options.onIntentCanvasOpenRequestConsumed}
        onAttachToThread={options.onAttachIntentCanvasToThread}
        onOpenProjectMap={options.onOpenProjectMap}
        onOpenSourceFile={handleOpenProjectMapEvidenceFile}
      />
    </Suspense>
  ) : null;

  const planPanelNode = shouldMountBottomStatusPanel ? (
    <ActiveCanvasStatusPanel
      workspaceId={options.activeWorkspace?.id ?? null}
      workspaceName={options.activeWorkspace?.name ?? null}
      workspacePath={options.activeWorkspace?.path ?? null}
      branchName={options.branchName}
      items={EMPTY_ACTIVE_CANVAS_ITEMS}
      isProcessing={false}
      expanded
      plan={null}
      isPlanMode={options.isPlanMode}
      isCodexEngine={isStatusPanelCodexEngine}
      activeThreadId={null}
      activeTurnId={null}
      selectedEngine={options.selectedEngine}
      selectedModelId={options.selectedModelId}
      activeTokenUsage={null}
      workspaceGitFiles={options.gitStatus.files}
      workspaceGitStagedFiles={options.gitStatus.stagedFiles}
      workspaceGitUnstagedFiles={options.gitStatus.unstagedFiles}
      workspaceGitTotals={{
        additions: options.gitStatus.totalAdditions,
        deletions: options.gitStatus.totalDeletions,
      }}
      workspaceGitDiffs={options.gitDiffs}
      itemsByThread={{}}
      threadParentById={options.threadParentById}
      threadStatusById={{}}
      onOpenDiffPath={handleOpenDiffPath}
      onOpenFilePath={handleOpenDiffFromActivity}
      onSelectSubagent={options.onSelectSubagent}
      onJumpToConversationMessage={dispatchMessageJumpEvent}
      variant="dock"
      visibleDockTabs={bottomActivityVisibleTabs}
      onRefreshGitStatus={options.queueGitStatusRefresh}
      commitMessage={options.commitMessage}
      commitMessageLoading={options.commitMessageLoading}
      commitMessageError={options.commitMessageError}
      onCommitMessageChange={options.onCommitMessageChange}
      onGenerateCommitMessage={options.onGenerateCommitMessage}
      onCommit={options.onCommit}
      commitLoading={options.commitLoading}
      commitError={options.commitError}
      preferredDockTab={preferredDockStatusTab?.tab ?? null}
      preferredDockTabRequestKey={preferredDockStatusTab?.requestKey ?? 0}
      dockCollapsed={!showBottomStatusPanel}
      onExpandToDock={handleExpandCheckpointToDock}
      {...codeAnnotationBridgeProps}
    />
  ) : null;

  const terminalDockNode = buildTerminalDockNode({
    terminalState: options.terminalState,
    terminalOpen: options.terminalOpen,
    terminalTabs: options.terminalTabs,
    activeTerminalId: options.activeTerminalId,
    onToggleTerminal: options.onToggleTerminal,
    onSelectTerminal: options.onSelectTerminal,
    onNewTerminal: options.onNewTerminal,
    onCloseTerminal: options.onCloseTerminal,
    onResizeTerminal: options.onResizeTerminal,
  });

  const { debugPanelNode, debugPanelFullNode } = buildDebugPanelNodes({
    debugEntries: options.debugEntries,
    debugOpen: options.debugOpen,
    onClearDebug: options.onClearDebug,
    onCopyDebug: options.onCopyDebug,
    onResizeDebug: options.onResizeDebug,
  });

  const compactEmptyCodexNode = buildCompactEmptyNode({
    title: t("workspace.noWorkspaceSelected"),
    description: t("workspace.chooseProjectToChat"),
    buttonLabel: t("workspace.goToProjects"),
    onGoProjects: options.onGoProjects,
  });

  const compactEmptyGitNode = buildCompactEmptyNode({
    title: t("workspace.noWorkspaceSelected"),
    description: t("workspace.selectProjectToInspect"),
    buttonLabel: t("workspace.goToProjects"),
    onGoProjects: options.onGoProjects,
  });

  const compactEmptySpecNode = buildCompactEmptyNode({
    title: t("workspace.noWorkspaceSelected"),
    description: t("workspace.selectProjectToReadSpecs"),
    buttonLabel: t("workspace.goToProjects"),
    onGoProjects: options.onGoProjects,
  });

  const compactGitBackNode = buildCompactGitBackNode({
    backLabel: t("workspace.back"),
    diffLabel: t("workspace.diff"),
    onBackFromDiff: options.onBackFromDiff,
  });
  const browserDockNode = null;

  return {
    codeAnnotationBridgeProps,
    sidebarNode,
    messagesNode,
    composerNode,
    approvalToastsNode,
    updateToastNode,
    errorToastsNode,
    globalRuntimeNoticeDockNode: appRuntimeNoticeDockNode,
    homeNode,
    mainHeaderNode,
    desktopTopbarLeftNode,
    tabletNavNode,
    tabBarNode,
    rightPanelToolbarNode,
    gitDiffPanelNode,
    gitDiffViewerNode,
    fileViewPanelNode,
    projectMapPanelNode,
    intentCanvasPanelNode,
    browserDockNode,
    planPanelNode,
    debugPanelNode,
    debugPanelFullNode,
    terminalDockNode,
    compactEmptyCodexNode,
    compactEmptySpecNode,
    compactEmptyGitNode,
    compactGitBackNode,
  };
}
