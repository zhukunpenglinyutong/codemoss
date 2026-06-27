import { memo } from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { DesktopLayout } from "../../layout/components/DesktopLayout";
import { TabletLayout } from "../../layout/components/TabletLayout";
import { PhoneLayout } from "../../layout/components/PhoneLayout";
type AppLayoutProps = {
  isPhone: boolean;
  isTablet: boolean;
  showHome: boolean;
  showKanban: boolean;
  showGitHistory: boolean;
  hideRightPanel: boolean;
  rightPanelCollapsed?: boolean;
  isSoloMode: boolean;
  kanbanNode: ReactNode;
  gitHistoryNode: ReactNode;
  showGitDetail: boolean;
  activeTab: "projects" | "codex" | "spec" | "git" | "log";
  tabletTab: "codex" | "spec" | "git" | "log";
  centerMode: "chat" | "diff" | "editor" | "memory" | "projectMap" | "intentCanvas";
  editorSplitLayout: "vertical" | "horizontal";
  editorSplitCompanion: "chat" | "projectMap";
  isEditorFileMaximized: boolean;
  hasActivePlan: boolean;
  activeWorkspace: boolean;
  sidebarNode: ReactNode;
  messagesNode: ReactNode;
  composerNode: ReactNode;
  approvalToastsNode: ReactNode;
  updateToastNode: ReactNode;
  errorToastsNode: ReactNode;
  globalRuntimeNoticeDockNode: ReactNode;
  homeNode: ReactNode;
  mainHeaderNode: ReactNode;
  desktopTopbarLeftNode: ReactNode;
  tabletNavNode: ReactNode;
  tabBarNode: ReactNode;
  rightPanelToolbarNode: ReactNode;
  gitDiffPanelNode: ReactNode;
  gitDiffViewerNode: ReactNode;
  fileViewPanelNode: ReactNode;
  projectMapPanelNode: ReactNode;
  intentCanvasPanelNode: ReactNode;
  browserDockNode?: ReactNode;
  planPanelNode: ReactNode;
  runtimeConsoleDockNode: ReactNode;
  debugPanelNode: ReactNode;
  debugPanelFullNode: ReactNode;
  terminalDockNode: ReactNode;
  compactEmptyCodexNode: ReactNode;
  compactEmptySpecNode: ReactNode;
  compactEmptyGitNode: ReactNode;
  compactGitBackNode: ReactNode;
  settingsOpen: boolean;
  settingsNode: ReactNode;
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onRightPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onPlanPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onGitHistoryPanelResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onCollapseRightPanel?: () => void;
  onExpandRightPanel?: () => void;
};

export const AppLayout = memo(function AppLayout({
  isPhone,
  isTablet,
  showHome,
  showKanban,
  showGitHistory,
  hideRightPanel,
  rightPanelCollapsed = false,
  isSoloMode,
  kanbanNode,
  gitHistoryNode,
  showGitDetail,
  activeTab,
  tabletTab,
  centerMode,
  editorSplitLayout,
  editorSplitCompanion,
  isEditorFileMaximized,
  hasActivePlan,
  activeWorkspace,
  sidebarNode,
  messagesNode,
  composerNode,
  approvalToastsNode,
  updateToastNode,
  errorToastsNode,
  globalRuntimeNoticeDockNode,
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
  browserDockNode = null,
  planPanelNode,
  runtimeConsoleDockNode,
  debugPanelNode,
  debugPanelFullNode,
  terminalDockNode,
  compactEmptyCodexNode,
  compactEmptySpecNode,
  compactEmptyGitNode,
  compactGitBackNode,
  settingsOpen,
  settingsNode,
  onSidebarResizeStart,
  onRightPanelResizeStart,
  onPlanPanelResizeStart,
  onGitHistoryPanelResizeStart,
  onCollapseRightPanel,
  onExpandRightPanel,
}: AppLayoutProps) {
  if (isPhone) {
    return (
      <PhoneLayout
        approvalToastsNode={approvalToastsNode}
        updateToastNode={updateToastNode}
        errorToastsNode={errorToastsNode}
        globalRuntimeNoticeDockNode={globalRuntimeNoticeDockNode}
        tabBarNode={tabBarNode}
        sidebarNode={sidebarNode}
        activeTab={activeTab}
        showGitHistory={showGitHistory}
        gitHistoryNode={gitHistoryNode}
        activeWorkspace={activeWorkspace}
        showGitDetail={showGitDetail}
        compactEmptyCodexNode={compactEmptyCodexNode}
        compactEmptySpecNode={compactEmptySpecNode}
        compactEmptyGitNode={compactEmptyGitNode}
        compactGitBackNode={compactGitBackNode}
        topbarLeftNode={mainHeaderNode}
        messagesNode={messagesNode}
        composerNode={composerNode}
        gitDiffPanelNode={gitDiffPanelNode}
        gitDiffViewerNode={gitDiffViewerNode}
        debugPanelNode={debugPanelFullNode}
        settingsOpen={settingsOpen}
        settingsNode={settingsNode}
      />
    );
  }

  if (isTablet) {
    return (
      <TabletLayout
        tabletNavNode={tabletNavNode}
        approvalToastsNode={approvalToastsNode}
        updateToastNode={updateToastNode}
        errorToastsNode={errorToastsNode}
        globalRuntimeNoticeDockNode={globalRuntimeNoticeDockNode}
        showGitHistory={showGitHistory}
        gitHistoryNode={gitHistoryNode}
        homeNode={homeNode}
        showHome={showHome}
        showWorkspace={activeWorkspace && !showHome}
        sidebarNode={sidebarNode}
        tabletTab={tabletTab}
        onSidebarResizeStart={onSidebarResizeStart}
        topbarLeftNode={mainHeaderNode}
        messagesNode={messagesNode}
        composerNode={composerNode}
        gitDiffPanelNode={gitDiffPanelNode}
        gitDiffViewerNode={gitDiffViewerNode}
        debugPanelNode={debugPanelFullNode}
        settingsOpen={settingsOpen}
        settingsNode={settingsNode}
      />
    );
  }

  return (
    <DesktopLayout
      sidebarNode={sidebarNode}
      updateToastNode={updateToastNode}
      approvalToastsNode={approvalToastsNode}
      errorToastsNode={errorToastsNode}
      globalRuntimeNoticeDockNode={globalRuntimeNoticeDockNode}
      homeNode={homeNode}
      showHome={showHome}
      showWorkspace={(activeWorkspace || showHome) && !showKanban}
      showKanban={showKanban}
      showGitHistory={showGitHistory}
      hideRightPanel={hideRightPanel}
      rightPanelCollapsed={rightPanelCollapsed}
      isSoloMode={isSoloMode}
      kanbanNode={kanbanNode}
      gitHistoryNode={gitHistoryNode}
      settingsOpen={settingsOpen}
      settingsNode={settingsNode}
      topbarLeftNode={desktopTopbarLeftNode}
      centerMode={centerMode}
      editorSplitLayout={editorSplitLayout}
      editorSplitCompanion={editorSplitCompanion}
      isEditorFileMaximized={isEditorFileMaximized}
      messagesNode={messagesNode}
      gitDiffViewerNode={gitDiffViewerNode}
      fileViewPanelNode={fileViewPanelNode}
      projectMapPanelNode={projectMapPanelNode}
      intentCanvasPanelNode={intentCanvasPanelNode}
      browserDockNode={browserDockNode}
      rightPanelToolbarNode={rightPanelToolbarNode}
      gitDiffPanelNode={gitDiffPanelNode}
      planPanelNode={planPanelNode}
      composerNode={composerNode}
      runtimeConsoleDockNode={runtimeConsoleDockNode}
      terminalDockNode={terminalDockNode}
      debugPanelNode={debugPanelNode}
      hasActivePlan={hasActivePlan}
      onSidebarResizeStart={onSidebarResizeStart}
      onRightPanelResizeStart={onRightPanelResizeStart}
      onPlanPanelResizeStart={onPlanPanelResizeStart}
      onGitHistoryPanelResizeStart={onGitHistoryPanelResizeStart}
      onCollapseRightPanel={onCollapseRightPanel}
      onExpandRightPanel={onExpandRightPanel}
    />
  );
});
