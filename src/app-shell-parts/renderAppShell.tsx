import { cloneElement, isValidElement, Suspense } from "react";
import type * as React from "react";
import { AppLayout } from "../features/app/components/AppLayout";
import { AppModals } from "../features/app/components/AppModals";
import { LockScreenOverlay } from "../features/app/components/LockScreenOverlay";
import { RuntimeConsoleDock } from "../features/app/components/RuntimeConsoleDock";
import {
  SidebarCollapseButton,
  TitlebarExpandControls,
} from "../features/layout/components/SidebarToggleControls";
import {
  shouldShowFloatingTitlebarSidebarToggle,
  shouldShowMainTopbarSidebarToggle,
  shouldShowSidebarTopbarSidebarToggle,
} from "../features/layout/utils/sidebarTogglePlacement";
import {
  adaptAppShellLegacyFlatContext,
  flattenSelectedAppShellDomainContexts,
  type AppShellDomainContextName,
} from "./appShellDomainContexts";
import {
  GitHistoryPanel,
  KanbanView,
  ReleaseNotesModal,
  SearchPalette,
  SpecHub,
  WorkspaceHome,
} from "./lazyViews";
import type {
  RenderAppShellContext,
  RenderAppShellFlattenedContext,
} from "./renderAppShellTypes";

const RENDER_APP_SHELL_DOMAIN_NAMES = [
  "workspaceNavigationContext",
  "composerContext",
  "layoutContext",
  "fileEditorContext",
  "settingsContext",
  "runtimeContext",
  "modelSelectionContext",
  "collaborationModeContext",
] as const satisfies readonly AppShellDomainContextName[];

export function injectSidebarTopbarNode(
  sidebarNode: React.ReactNode,
  topbarNode: React.ReactNode,
) {
  if (!topbarNode || !isValidElement(sidebarNode)) {
    return sidebarNode;
  }

  const sidebarProps = sidebarNode.props as { children?: React.ReactNode };
  if (isValidElement(sidebarProps.children)) {
    return cloneElement(
      sidebarNode as React.ReactElement<{ children?: React.ReactNode }>,
      {
        children: cloneElement(
          sidebarProps.children as React.ReactElement<{
            topbarNode?: React.ReactNode;
          }>,
          { topbarNode },
        ),
      },
    );
  }

  return cloneElement(
    sidebarNode as React.ReactElement<{ topbarNode?: React.ReactNode }>,
    { topbarNode },
  );
}

export function renderAppShell(ctx: RenderAppShellContext) {
  const legacyCtx =
    adaptAppShellLegacyFlatContext<RenderAppShellFlattenedContext>({
      ...flattenSelectedAppShellDomainContexts(
        ctx.appShellDomainContexts,
        RENDER_APP_SHELL_DOMAIN_NAMES,
      ),
      ...ctx.searchAndComposerSection,
      ...ctx.sections,
      ...ctx.layoutNodes,
      isPullRequestComposer: ctx.isPullRequestComposer,
      isPullRequestComposerFromSections: ctx.isPullRequestComposerFromSections,
      sections: ctx.sections,
    });
  const {
    GitHubPanelData,
    SettingsView,
    activeEngine,
    activeTab,
    activeThreadId,
    activeWorkspace,
    appClassName,
    appRootRef,
    appSettings,
    approvalToastsNode,
    assignWorkspaceGroup,
    cancelClonePrompt,
    cancelWorktreePrompt,
    centerMode,
    chooseCloneCopiesFolder,
    clearCloneCopiesFolder,
    clonePrompt,
    closeReleaseNotes,
    closeSearchPalette,
    closeSettings,
    closeWorktreeCreateResult,
    dismissLoadingProgressDialog,
    codeAnnotationBridgeProps,
    compactEmptyCodexNode,
    compactEmptyGitNode,
    compactEmptySpecNode,
    compactGitBackNode,
    composerNode,
    confirmClonePrompt,
    confirmWorktreePrompt,
    collapseRightPanel,
    createWorkspaceGroup,
    debugPanelFullNode,
    debugPanelHeight,
    debugPanelNode,
    deleteWorkspaceGroup,
    desktopTopbarLeftNode,
    dictationModel,
    diffSource,
    directories,
    doctor,
    claudeDoctor,
    editorSplitCompanion,
    editorSplitLayout,
    engineStatuses,
    errorToastsNode,
    expandRightPanel,
    fileViewPanelNode,
    projectMapPanelNode,
    intentCanvasPanelNode,
    browserDockNode,
    files,
    gitDiffPanelNode,
    gitDiffViewerNode,
    gitHistoryPanelHeight,
    gitPanelMode,
    gitStatus,
    groupedWorkspaces,
    handleAddWorkspace,
    handleAppModeChange,
    handleCloseGitHistoryPanel,
    handleCloseTaskConversation,
    handleContinueLatestConversation,
    handleDeleteWorkspaceConversations,
    handleDeleteWorkspaceConversationsInSettings,
    handleDragToInProgress,
    handleEnsureWorkspaceThreadsForSettings,
    handleGitIssuesChange,
    handleGitPullRequestCommentsChange,
    handleGitPullRequestDiffsChange,
    handleGitPullRequestsChange,
    handleKanbanCreateTask,
    handleMoveWorkspace,
    handleOpenMailSession,
    handleOpenSpecHub,
    handleOpenTaskConversation,
    handleRetryTaskRun,
    handleResumeTaskRun,
    handleCancelTaskRun,
    handleForkTaskRun,
    handleRenamePromptCancel,
    handleRenamePromptChange,
    handleRenamePromptConfirm,
    handleRevealActiveWorkspace,
    handleSearchPaletteMoveSelection,
    handleSelectDiffForPanel,
    handleSelectSearchResult,
    handleSelectWorkspaceInstance,
    handleSelectWorkspacePathForGitHistory,
    handleStartGuidedConversation,
    handleStartSharedConversation,
    handleStartWorkspaceConversation,
    handleTestNotificationSound,
    handleToggleSearchContentFilter,
    handleToggleTerminalPanel,
    handleUnlockPanel,
    hasActivePlan,
    homeNode,
    globalRuntimeNoticeDockNode,
    installedEngines,
    isCompact,
    isEditorFileMaximized,
    isMacDesktop,
    isPanelLocked,
    isPhone,
    isSearchPaletteOpen,
    isSoloMode,
    isTablet,
    kanbanConversationWidth,
    kanbanCreatePanel,
    kanbanDeletePanel,
    kanbanDeleteTask,
    kanbanPanels,
    kanbanReorderTask,
    kanbanTasks,
    kanbanUpdatePanel,
    kanbanUpdateTask,
    kanbanViewState,
    lockLiveSessions,
    loadingProgressDialog,
    mainHeaderNode,
    messagesNode,
    moveWorkspaceGroup,
    onGitHistoryPanelResizeStart,
    onKanbanConversationResizeStart,
    onPlanPanelResizeStart,
    onRightPanelResizeStart,
    onSidebarResizeStart,
    openAppIconById,
    planPanelHeight,
    planPanelNode,
    queueSaveSettings,
    recentThreads,
    reduceTransparency,
    windowTransparencyEnabled,
    windowOpacity,
    releaseNotesActiveIndex,
    releaseNotesEntries,
    releaseNotesError,
    releaseNotesLoading,
    releaseNotesOpen,
    removeWorkspace,
    renamePrompt,
    renameWorkspaceGroup,
    retryReleaseNotesLoad,
    rightPanelCollapsed,
    rightPanelToolbarNode,
    rightPanelWidth,
    runtimeRunState,
    scaleShortcutText,
    scaleShortcutTitle,
    searchContentFilters,
    searchPaletteQuery,
    searchPaletteSelectedIndex,
    searchResults,
    searchScope,
    selectedKanbanTaskId,
    selectedPullRequest,
    setActiveTab,
    setActiveWorkspaceId,
    setAppSettings,
    setKanbanViewState,
    setReduceTransparency,
    setWindowTransparencyEnabled,
    setWindowOpacity,
    setSearchPaletteQuery,
    setSearchPaletteSelectedIndex,
    setSearchScope,
    settingsHighlightTarget,
    settingsOpen,
    settingsSection,
    shouldLoadDiffs,
    shouldLoadGitHubPanelData,
    shouldMountSpecHub,
    showGitDetail,
    showGitHistory,
    showHome,
    showKanban,
    showNextReleaseNotes,
    showPreviousReleaseNotes,
    showSpecHub,
    showWorkspaceHome,
    sidebarCollapsed,
    sidebarNode,
    sidebarToggleProps,
    sidebarWidth,
    sessionRadarRecentCompletedSessions,
    tabBarNode,
    tabletNavNode,
    tabletTab,
    taskProcessingMap,
    terminalDockNode,
    terminalOpen,
    terminalPanelHeight,
    threadListLoadingByWorkspace,
    threadsByWorkspace,
    ungroupedLabel,
    updateCloneCopyName,
    updateToastNode,
    updateWorkspaceCodexBin,
    updateWorkspaceSettings,
    updateWorktreeBaseRef,
    updateWorktreeBranch,
    updateWorktreePublishToOrigin,
    updateWorktreeSetupScript,
    useSuggestedCloneCopiesFolder,
    workspaceAliasPromptNode,
    workspaceGroups,
    workspaces,
    worktreeCreateResult,
    worktreePrompt,
  } = legacyCtx;

  const specHubNode = shouldMountSpecHub ? (
    <Suspense fallback={null}>
      <SpecHub
        workspaceId={activeWorkspace?.id ?? null}
        workspaceName={activeWorkspace?.name ?? null}
        files={files}
        directories={directories}
        onBackToChat={() => setActiveTab("codex")}
      />
    </Suspense>
  ) : null;

  const workspaceHomeNode =
    showWorkspaceHome && activeWorkspace ? (
      <Suspense fallback={null}>
        <WorkspaceHome
          workspace={activeWorkspace}
          engines={installedEngines}
          currentBranch={gitStatus.branchName || null}
          recentThreads={recentThreads}
          onSelectConversation={handleSelectWorkspaceInstance}
          onStartConversation={handleStartWorkspaceConversation}
          onStartSharedConversation={handleStartSharedConversation}
          onContinueLatestConversation={handleContinueLatestConversation}
          onStartGuidedConversation={handleStartGuidedConversation}
          onOpenSpecHub={handleOpenSpecHub}
          onRevealWorkspace={handleRevealActiveWorkspace}
          onDeleteConversations={handleDeleteWorkspaceConversations}
          onRetryTaskRun={handleRetryTaskRun}
          onResumeTaskRun={handleResumeTaskRun}
          onCancelTaskRun={handleCancelTaskRun}
          onForkTaskRun={handleForkTaskRun}
        />
      </Suspense>
    ) : null;

  const workspacePrimaryNode = showWorkspaceHome
    ? workspaceHomeNode
    : messagesNode;

  const mainMessagesNode = shouldMountSpecHub ? (
    <div className="workspace-chat-stack">
      <div
        className={`workspace-chat-layer ${showSpecHub ? "is-hidden" : "is-active"}`}
      >
        {workspacePrimaryNode}
      </div>
      <div
        className={`workspace-spec-layer ${showSpecHub ? "is-active" : "is-hidden"}`}
      >
        {specHubNode}
      </div>
    </div>
  ) : (
    workspacePrimaryNode
  );

  const kanbanConversationNode = selectedKanbanTaskId ? (
    <div className="kanban-conversation-content">
      {messagesNode}
      {composerNode}
    </div>
  ) : null;

  const gitHistoryNode = showGitHistory ? (
    <Suspense fallback={null}>
      <GitHistoryPanel
        workspace={activeWorkspace}
        workspaces={workspaces}
        groupedWorkspaces={groupedWorkspaces}
        onSelectWorkspace={setActiveWorkspaceId}
        onSelectWorkspacePath={handleSelectWorkspacePathForGitHistory}
        onOpenDiffPath={handleSelectDiffForPanel}
        onRequestClose={handleCloseGitHistoryPanel}
        {...codeAnnotationBridgeProps}
      />
    </Suspense>
  ) : null;

  const showSidebarTopbarSidebarToggle = shouldShowSidebarTopbarSidebarToggle({
    isCompact,
    isMacDesktop,
    isSoloMode,
    sidebarCollapsed,
  });
  const showMainTopbarSidebarToggle = shouldShowMainTopbarSidebarToggle({
    isCompact,
    isMacDesktop,
    isSoloMode,
    sidebarCollapsed,
  });
  const showFloatingTitlebarSidebarToggle =
    shouldShowFloatingTitlebarSidebarToggle({
      showHome,
      showMainTopbarSidebarToggle,
    });

  const desktopTopbarLeftNodeWithToggle = showMainTopbarSidebarToggle ? (
    <div className="topbar-leading">
      <SidebarCollapseButton {...sidebarToggleProps} />
      {desktopTopbarLeftNode}
    </div>
  ) : (
    desktopTopbarLeftNode
  );
  const sidebarTopbarToggleNode = showSidebarTopbarSidebarToggle ? (
    <div
      className={`sidebar-titlebar-toggle${
        sidebarToggleProps.isLayoutSwapped ? " is-layout-swapped" : ""
      }`}
      data-tauri-drag-region="false"
    >
      <SidebarCollapseButton {...sidebarToggleProps} />
    </div>
  ) : null;
  const sidebarNodeWithTopbar =
    sidebarTopbarToggleNode !== null
      ? injectSidebarTopbarNode(sidebarNode, sidebarTopbarToggleNode)
      : sidebarNode;
  const runtimeConsoleDockNode = (
    <RuntimeConsoleDock
      isVisible={runtimeRunState.runtimeConsoleVisible}
      status={runtimeRunState.runtimeConsoleStatus}
      commandPreview={runtimeRunState.runtimeConsoleCommandPreview}
      log={runtimeRunState.runtimeConsoleLog}
      error={runtimeRunState.runtimeConsoleError}
      exitCode={runtimeRunState.runtimeConsoleExitCode}
      truncated={runtimeRunState.runtimeConsoleTruncated}
      autoScroll={runtimeRunState.runtimeAutoScroll}
      wrapLines={runtimeRunState.runtimeWrapLines}
      commandPresetOptions={runtimeRunState.runtimeCommandPresetOptions}
      commandPresetId={runtimeRunState.runtimeCommandPresetId}
      commandInput={runtimeRunState.runtimeCommandInput}
      onRun={runtimeRunState.onRunProject}
      onCommandPresetChange={runtimeRunState.onSelectRuntimeCommandPreset}
      onCommandInputChange={runtimeRunState.onChangeRuntimeCommandInput}
      onStop={runtimeRunState.onStopProject}
      onClear={runtimeRunState.onClearRuntimeLogs}
      onCopy={runtimeRunState.onCopyRuntimeLogs}
      onToggleAutoScroll={runtimeRunState.onToggleRuntimeAutoScroll}
      onToggleWrapLines={runtimeRunState.onToggleRuntimeWrapLines}
    />
  );

  return (
    <div
      ref={appRootRef}
      className={appClassName}
      style={
        {
          "--sidebar-width": `${
            isCompact
              ? sidebarWidth
              : settingsOpen
                ? 0
                : sidebarCollapsed
                  ? 0
                  : sidebarWidth
          }px`,
          "--right-panel-width": `${
            isCompact
              ? rightPanelWidth
              : rightPanelCollapsed
                ? 0
                : rightPanelWidth
          }px`,
          "--plan-panel-height": `${planPanelHeight}px`,
          "--terminal-panel-height": `${terminalPanelHeight}px`,
          "--debug-panel-height": `${debugPanelHeight}px`,
          "--git-history-panel-height": `${gitHistoryPanelHeight}px`,
          "--ui-font-family": appSettings.uiFontFamily,
          "--code-font-family": appSettings.codeFontFamily,
          "--code-font-size": `${appSettings.codeFontSize}px`,
        } as React.CSSProperties
      }
    >
      <div className="drag-strip" id="titlebar" data-tauri-drag-region />
      <TitlebarExpandControls
        {...sidebarToggleProps}
        showSidebarTitlebarToggle={showFloatingTitlebarSidebarToggle}
      />
      {shouldLoadGitHubPanelData ? (
        <Suspense fallback={null}>
          <GitHubPanelData
            activeWorkspace={activeWorkspace}
            gitPanelMode={gitPanelMode}
            shouldLoadDiffs={shouldLoadDiffs}
            diffSource={diffSource}
            selectedPullRequestNumber={selectedPullRequest?.number ?? null}
            onIssuesChange={handleGitIssuesChange}
            onPullRequestsChange={handleGitPullRequestsChange}
            onPullRequestDiffsChange={handleGitPullRequestDiffsChange}
            onPullRequestCommentsChange={handleGitPullRequestCommentsChange}
          />
        </Suspense>
      ) : null}
      <AppLayout
        isPhone={isPhone}
        isTablet={isTablet}
        showHome={showHome}
        showKanban={showKanban}
        showGitHistory={showGitHistory}
        hideRightPanel={activeTab === "spec" && rightPanelCollapsed}
        rightPanelCollapsed={!isCompact && rightPanelCollapsed}
        isSoloMode={isSoloMode}
        kanbanNode={
          showKanban ? (
            <Suspense fallback={null}>
              <KanbanView
                viewState={kanbanViewState}
                onViewStateChange={setKanbanViewState}
                workspaces={workspaces}
                panels={kanbanPanels}
                tasks={kanbanTasks}
                onCreateTask={handleKanbanCreateTask}
                onUpdateTask={kanbanUpdateTask}
                onDeleteTask={kanbanDeleteTask}
                onReorderTask={kanbanReorderTask}
                onCreatePanel={kanbanCreatePanel}
                onUpdatePanel={kanbanUpdatePanel}
                onDeletePanel={kanbanDeletePanel}
                onAddWorkspace={handleAddWorkspace}
                onAppModeChange={handleAppModeChange}
                engineStatuses={engineStatuses}
                conversationNode={kanbanConversationNode}
                selectedTaskId={selectedKanbanTaskId}
                taskProcessingMap={taskProcessingMap}
                onOpenTaskConversation={handleOpenTaskConversation}
                onCloseTaskConversation={handleCloseTaskConversation}
                onDragToInProgress={handleDragToInProgress}
                kanbanConversationWidth={kanbanConversationWidth}
                onKanbanConversationResizeStart={
                  onKanbanConversationResizeStart
                }
                gitPanelNode={gitDiffPanelNode}
                terminalOpen={terminalOpen}
                onToggleTerminal={handleToggleTerminalPanel}
              />
            </Suspense>
          ) : null
        }
        gitHistoryNode={gitHistoryNode}
        showGitDetail={showGitDetail}
        activeTab={activeTab}
        tabletTab={tabletTab}
        centerMode={centerMode}
        editorSplitLayout={editorSplitLayout}
        editorSplitCompanion={editorSplitCompanion}
        isEditorFileMaximized={isEditorFileMaximized}
        hasActivePlan={hasActivePlan}
        activeWorkspace={Boolean(activeWorkspace)}
        sidebarNode={sidebarNodeWithTopbar}
        messagesNode={mainMessagesNode}
        composerNode={composerNode}
        approvalToastsNode={approvalToastsNode}
        updateToastNode={updateToastNode}
        errorToastsNode={errorToastsNode}
        globalRuntimeNoticeDockNode={globalRuntimeNoticeDockNode}
        homeNode={homeNode}
        mainHeaderNode={mainHeaderNode}
        desktopTopbarLeftNode={desktopTopbarLeftNodeWithToggle}
        tabletNavNode={tabletNavNode}
        tabBarNode={tabBarNode}
        rightPanelToolbarNode={rightPanelToolbarNode}
        gitDiffPanelNode={gitDiffPanelNode}
        gitDiffViewerNode={gitDiffViewerNode}
        fileViewPanelNode={fileViewPanelNode}
        projectMapPanelNode={projectMapPanelNode}
        intentCanvasPanelNode={intentCanvasPanelNode}
        browserDockNode={browserDockNode}
        planPanelNode={planPanelNode}
        runtimeConsoleDockNode={runtimeConsoleDockNode}
        debugPanelNode={debugPanelNode}
        debugPanelFullNode={debugPanelFullNode}
        terminalDockNode={terminalDockNode}
        compactEmptyCodexNode={compactEmptyCodexNode}
        compactEmptySpecNode={compactEmptySpecNode}
        compactEmptyGitNode={compactEmptyGitNode}
        compactGitBackNode={compactGitBackNode}
        settingsOpen={settingsOpen}
        settingsNode={
          settingsOpen ? (
            <Suspense fallback={null}>
              <SettingsView
                workspaceGroups={workspaceGroups}
                groupedWorkspaces={groupedWorkspaces}
                allWorkspaces={workspaces}
                ungroupedLabel={ungroupedLabel}
                onMoveWorkspace={handleMoveWorkspace}
                onDeleteWorkspace={(workspaceId: string) => {
                  void removeWorkspace(workspaceId);
                }}
                onCreateWorkspaceGroup={createWorkspaceGroup}
                onRenameWorkspaceGroup={renameWorkspaceGroup}
                onMoveWorkspaceGroup={moveWorkspaceGroup}
                onDeleteWorkspaceGroup={deleteWorkspaceGroup}
                onAssignWorkspaceGroup={assignWorkspaceGroup}
                reduceTransparency={reduceTransparency}
                onToggleTransparency={setReduceTransparency}
                windowTransparencyEnabled={windowTransparencyEnabled}
                onToggleWindowTransparency={setWindowTransparencyEnabled}
                windowOpacity={windowOpacity}
                onWindowOpacityChange={setWindowOpacity}
                appSettings={appSettings}
                openAppIconById={openAppIconById}
                onUpdateAppSettings={async (next: any) => {
                  setAppSettings(next);
                  await queueSaveSettings(next);
                }}
                onOpenMailSession={handleOpenMailSession}
                onRunCodexDoctor={doctor}
                onRunClaudeDoctor={claudeDoctor}
                activeWorkspace={activeWorkspace}
                activeThreadId={activeThreadId}
                activeEngine={activeEngine}
                onUpdateWorkspaceCodexBin={async (
                  id: string,
                  codexBin: string,
                ) => {
                  await updateWorkspaceCodexBin(id, codexBin);
                }}
                onUpdateWorkspaceSettings={async (
                  id: string,
                  settings: any,
                ) => {
                  await updateWorkspaceSettings(id, settings);
                }}
                workspaceThreadsById={threadsByWorkspace}
                workspaceThreadListLoadingById={threadListLoadingByWorkspace}
                sessionRadarRecentCompletedSessions={
                  sessionRadarRecentCompletedSessions
                }
                onEnsureWorkspaceThreads={
                  handleEnsureWorkspaceThreadsForSettings
                }
                onDeleteWorkspaceThreads={
                  handleDeleteWorkspaceConversationsInSettings
                }
                scaleShortcutTitle={scaleShortcutTitle}
                scaleShortcutText={scaleShortcutText}
                onTestNotificationSound={handleTestNotificationSound}
                dictationModelStatus={dictationModel.status}
                onDownloadDictationModel={dictationModel.download}
                onCancelDictationDownload={dictationModel.cancel}
                onRemoveDictationModel={dictationModel.remove}
                onClose={closeSettings}
                initialSection={settingsSection ?? undefined}
                initialHighlightTarget={settingsHighlightTarget ?? undefined}
              />
            </Suspense>
          ) : null
        }
        onSidebarResizeStart={onSidebarResizeStart}
        onRightPanelResizeStart={onRightPanelResizeStart}
        onPlanPanelResizeStart={onPlanPanelResizeStart}
        onGitHistoryPanelResizeStart={onGitHistoryPanelResizeStart}
        onCollapseRightPanel={collapseRightPanel}
        onExpandRightPanel={expandRightPanel}
      />
      <LockScreenOverlay
        isOpen={isPanelLocked}
        onUnlock={handleUnlockPanel}
        liveSessions={lockLiveSessions}
      />
      {isSearchPaletteOpen ? (
        <Suspense fallback={null}>
          <SearchPalette
            isOpen={isSearchPaletteOpen}
            scope={searchScope}
            contentFilters={searchContentFilters}
            workspaceName={activeWorkspace?.name ?? null}
            query={searchPaletteQuery}
            results={searchResults}
            selectedIndex={searchPaletteSelectedIndex}
            onQueryChange={setSearchPaletteQuery}
            onMoveSelection={handleSearchPaletteMoveSelection}
            onSelect={(result) => {
              void handleSelectSearchResult(result);
            }}
            onScopeChange={(nextScope) => {
              setSearchScope(nextScope);
              setSearchPaletteSelectedIndex(0);
            }}
            onContentFilterToggle={handleToggleSearchContentFilter}
            onClose={closeSearchPalette}
          />
        </Suspense>
      ) : null}
      {releaseNotesOpen ? (
        <Suspense fallback={null}>
          <ReleaseNotesModal
            isOpen={releaseNotesOpen}
            entries={releaseNotesEntries}
            activeIndex={releaseNotesActiveIndex}
            loading={releaseNotesLoading}
            error={releaseNotesError}
            onClose={closeReleaseNotes}
            onPrev={showPreviousReleaseNotes}
            onNext={showNextReleaseNotes}
            onRetry={retryReleaseNotesLoad}
          />
        </Suspense>
      ) : null}
      {workspaceAliasPromptNode}
      <AppModals
        loadingProgressDialog={loadingProgressDialog}
        onLoadingProgressDialogClose={dismissLoadingProgressDialog}
        renamePrompt={renamePrompt}
        onRenamePromptChange={handleRenamePromptChange}
        onRenamePromptCancel={handleRenamePromptCancel}
        onRenamePromptConfirm={handleRenamePromptConfirm}
        worktreePrompt={worktreePrompt}
        onWorktreePromptChange={updateWorktreeBranch}
        onWorktreePromptBaseRefChange={updateWorktreeBaseRef}
        onWorktreePromptPublishChange={updateWorktreePublishToOrigin}
        onWorktreeSetupScriptChange={updateWorktreeSetupScript}
        onWorktreePromptCancel={cancelWorktreePrompt}
        onWorktreePromptConfirm={confirmWorktreePrompt}
        worktreeCreateResult={worktreeCreateResult}
        onWorktreeCreateResultClose={closeWorktreeCreateResult}
        clonePrompt={clonePrompt}
        onClonePromptCopyNameChange={updateCloneCopyName}
        onClonePromptChooseCopiesFolder={chooseCloneCopiesFolder}
        onClonePromptUseSuggestedFolder={useSuggestedCloneCopiesFolder}
        onClonePromptClearCopiesFolder={clearCloneCopiesFolder}
        onClonePromptCancel={cancelClonePrompt}
        onClonePromptConfirm={confirmClonePrompt}
      />
    </div>
  );
}
