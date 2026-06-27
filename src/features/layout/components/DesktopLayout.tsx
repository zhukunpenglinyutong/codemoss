import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open";
import { MainTopbar } from "../../app/components/MainTopbar";
import { MemoryPanel } from "./MemoryPanel";

type DesktopLayoutProps = {
  sidebarNode: ReactNode;
  updateToastNode: ReactNode;
  approvalToastsNode: ReactNode;
  errorToastsNode: ReactNode;
  globalRuntimeNoticeDockNode: ReactNode;
  homeNode: ReactNode;
  showHome: boolean;
  showWorkspace: boolean;
  showKanban: boolean;
  showGitHistory: boolean;
  hideRightPanel: boolean;
  rightPanelCollapsed?: boolean;
  isSoloMode: boolean;
  kanbanNode: ReactNode;
  gitHistoryNode: ReactNode;
  settingsOpen: boolean;
  settingsNode: ReactNode;
  topbarLeftNode: ReactNode;
  centerMode: "chat" | "diff" | "editor" | "memory" | "projectMap" | "intentCanvas";
  editorSplitLayout: "vertical" | "horizontal";
  editorSplitCompanion: "chat" | "projectMap";
  isEditorFileMaximized: boolean;
  messagesNode: ReactNode;
  gitDiffViewerNode: ReactNode;
  fileViewPanelNode: ReactNode;
  projectMapPanelNode?: ReactNode;
  intentCanvasPanelNode?: ReactNode;
  browserDockNode?: ReactNode;
  rightPanelToolbarNode: ReactNode;
  gitDiffPanelNode: ReactNode;
  planPanelNode: ReactNode;
  composerNode: ReactNode;
  runtimeConsoleDockNode: ReactNode;
  terminalDockNode: ReactNode;
  debugPanelNode: ReactNode;
  hasActivePlan: boolean;
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onRightPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onPlanPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onGitHistoryPanelResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onCollapseRightPanel?: () => void;
  onExpandRightPanel?: () => void;
};

export function DesktopLayout({
  sidebarNode,
  updateToastNode,
  approvalToastsNode,
  errorToastsNode,
  globalRuntimeNoticeDockNode,
  homeNode,
  showHome,
  showWorkspace,
  showKanban,
  showGitHistory,
  hideRightPanel,
  rightPanelCollapsed = false,
  isSoloMode,
  kanbanNode,
  gitHistoryNode,
  settingsOpen,
  settingsNode,
  topbarLeftNode,
  centerMode,
  editorSplitLayout,
  editorSplitCompanion,
  isEditorFileMaximized,
  messagesNode,
  gitDiffViewerNode,
  fileViewPanelNode,
  projectMapPanelNode = null,
  intentCanvasPanelNode = null,
  browserDockNode = null,
  rightPanelToolbarNode,
  gitDiffPanelNode,
  planPanelNode,
  composerNode,
  runtimeConsoleDockNode,
  terminalDockNode,
  debugPanelNode,
  onSidebarResizeStart,
  onRightPanelResizeStart,
  onPlanPanelResizeStart,
  onGitHistoryPanelResizeStart,
  onCollapseRightPanel,
  onExpandRightPanel,
}: DesktopLayoutProps) {
  const { t } = useTranslation();
  const diffLayerRef = useRef<HTMLDivElement | null>(null);
  const chatLayerRef = useRef<HTMLDivElement | null>(null);
  const editorLayerRef = useRef<HTMLDivElement | null>(null);
  const projectMapLayerRef = useRef<HTMLDivElement | null>(null);
  const intentCanvasLayerRef = useRef<HTMLDivElement | null>(null);
  const memoryLayerRef = useRef<HTMLDivElement | null>(null);
  const splitResizeCleanupRef = useRef<(() => void) | null>(null);
  const isEditorSplitMode = centerMode === "editor";
  const isEditorHorizontalSplitMode =
    isEditorSplitMode && editorSplitLayout === "horizontal";
  const isEditorSplitChatVisible =
    isEditorSplitMode && editorSplitCompanion === "chat" && !isEditorFileMaximized;
  const isEditorSplitProjectMapVisible =
    isEditorSplitMode &&
    editorSplitCompanion === "projectMap" &&
    !isEditorFileMaximized;
  const isBrowserDockSplitVisible = centerMode === "chat" && Boolean(browserDockNode);
  const isMemoryMode = centerMode === "memory";
  const shouldPlaceComposerInChatColumn =
    isEditorSplitChatVisible || isBrowserDockSplitVisible;
  const hasBottomPanel = Boolean(planPanelNode);
  const shouldShowComposerBelowContent =
    centerMode !== "projectMap" &&
    centerMode !== "intentCanvas" &&
    !shouldPlaceComposerInChatColumn &&
    !isEditorSplitProjectMapVisible;
  const isRightPanelCollapsed = rightPanelCollapsed || hideRightPanel;
  const shouldShowRightPanel = !isRightPanelCollapsed && !settingsOpen && !isMemoryMode;
  const rightPanelNode = shouldShowRightPanel ? (
    <>
      <div
        className="right-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("layout.resizeRightPanel")}
        onMouseDown={onRightPanelResizeStart}
      />
      {onCollapseRightPanel ? (
        <button
          type="button"
          className="right-panel-shell-toggle"
          onClick={onCollapseRightPanel}
          aria-label="收起实时统计侧栏"
          title="收起实时统计侧栏"
        >
          <PanelRightClose size={16} aria-hidden />
        </button>
      ) : null}
      <div
        className={`right-panel ${
          hasBottomPanel && !isSoloMode ? "" : "plan-collapsed"
        }${isSoloMode ? " is-solo" : ""}`}
      >
        {rightPanelToolbarNode}
        <div className="right-panel-top">{gitDiffPanelNode}</div>
        {hasBottomPanel ? (
          <>
            <div
              className="right-panel-divider"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("layout.resizePlanPanel")}
              onMouseDown={onPlanPanelResizeStart}
            />
            <div className="right-panel-bottom">{planPanelNode}</div>
          </>
        ) : null}
      </div>
    </>
  ) : null;
  const rightPanelCollapsedNode =
    isRightPanelCollapsed && !settingsOpen && !isMemoryMode && onExpandRightPanel ? (
      <button
        type="button"
        className="right-panel-collapsed-rail"
        onClick={onExpandRightPanel}
        aria-label="展开实时统计侧栏"
        title="展开实时统计侧栏"
      >
        <PanelRightOpen size={16} aria-hidden />
        <span>实时统计</span>
      </button>
    ) : null;

  useEffect(() => {
    const diffLayer = diffLayerRef.current;
    const chatLayer = chatLayerRef.current;
    const editorLayer = editorLayerRef.current;
    const projectMapLayer = projectMapLayerRef.current;
    const intentCanvasLayer = intentCanvasLayerRef.current;

    const layers = [
      { ref: diffLayer, mode: "diff" as const },
      { ref: chatLayer, mode: "chat" as const },
      { ref: editorLayer, mode: "editor" as const },
      { ref: projectMapLayer, mode: "projectMap" as const },
      { ref: intentCanvasLayer, mode: "intentCanvas" as const },
    ];

    for (const { ref, mode } of layers) {
      if (!ref) continue;
      const isInteractive =
        centerMode === mode ||
        (isEditorSplitChatVisible && mode === "chat") ||
        (isEditorSplitProjectMapVisible && mode === "projectMap");
      if (isInteractive) {
        ref.removeAttribute("inert");
      } else {
        ref.setAttribute("inert", "");
      }
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      for (const { ref, mode } of layers) {
        const isInteractive =
          centerMode === mode ||
          (isEditorSplitChatVisible && mode === "chat") ||
          (isEditorSplitProjectMapVisible && mode === "projectMap");
        if (ref && !isInteractive && ref.contains(activeElement)) {
          activeElement.blur();
          break;
        }
      }
    }
  }, [centerMode, isEditorSplitChatVisible, isEditorSplitProjectMapVisible]);

  useEffect(() => {
    return () => {
      splitResizeCleanupRef.current?.();
      splitResizeCleanupRef.current = null;
    };
  }, []);

  const handleHorizontalSplitPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const divider = event.currentTarget;
      const splitRoot = divider.closest(".content.is-editor-split-horizontal") as HTMLElement | null;
      if (!splitRoot) {
        return;
      }
      const editorLayer = splitRoot.querySelector(
        ".content-layer--editor",
      ) as HTMLElement | null;
      const chatLayer = splitRoot.querySelector(
        ".content-layer--editor-companion",
      ) as HTMLElement | null;
      if (!editorLayer || !chatLayer) {
        return;
      }
      const editorRect = editorLayer.getBoundingClientRect();
      const chatRect = chatLayer.getBoundingClientRect();
      const totalWidth = editorRect.width + chatRect.width;
      if (totalWidth <= 0) {
        return;
      }

      event.preventDefault();

      const startX = event.clientX;
      const startEditorWidth = editorRect.width;
      const minEditorWidth = Math.max(320, totalWidth * 0.28);
      const maxEditorWidth = Math.min(totalWidth - 260, totalWidth * 0.8);
      if (maxEditorWidth <= minEditorWidth) {
        return;
      }

      document.body.classList.add("editor-horizontal-split-resizing");

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        document.body.classList.remove("editor-horizontal-split-resizing");
        splitResizeCleanupRef.current = null;
      };

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextEditorWidth = Math.min(
          maxEditorWidth,
          Math.max(minEditorWidth, startEditorWidth - deltaX),
        );
        const nextRatio = (nextEditorWidth / totalWidth) * 100;
        splitRoot.style.setProperty("--editor-horizontal-split-ratio", nextRatio.toFixed(2));
      };

      const handlePointerUp = () => {
        cleanup();
      };

      splitResizeCleanupRef.current?.();
      splitResizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [],
  );
  const handleBrowserDockSplitPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const divider = event.currentTarget;
      const splitRoot = divider.closest(".content.is-browser-dock-split") as HTMLElement | null;
      if (!splitRoot) {
        return;
      }
      const chatLayer = splitRoot.querySelector(
        ".content-layer--chat",
      ) as HTMLElement | null;
      const browserLayer = splitRoot.querySelector(
        ".content-layer--browser-dock",
      ) as HTMLElement | null;
      if (!chatLayer || !browserLayer) {
        return;
      }
      const chatRect = chatLayer.getBoundingClientRect();
      const browserRect = browserLayer.getBoundingClientRect();
      const totalWidth = chatRect.width + browserRect.width;
      if (totalWidth <= 0) {
        return;
      }

      event.preventDefault();

      const startX = event.clientX;
      const startBrowserWidth = browserRect.width;
      const minBrowserWidth = Math.max(320, totalWidth * 0.24);
      const maxBrowserWidth = Math.min(totalWidth - 320, totalWidth * 0.72);
      if (maxBrowserWidth <= minBrowserWidth) {
        return;
      }

      document.body.classList.add("browser-dock-split-resizing");

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        document.body.classList.remove("browser-dock-split-resizing");
        splitResizeCleanupRef.current = null;
      };

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextBrowserWidth = Math.min(
          maxBrowserWidth,
          Math.max(minBrowserWidth, startBrowserWidth - deltaX),
        );
        const nextRatio = (nextBrowserWidth / totalWidth) * 100;
        splitRoot.style.setProperty("--browser-dock-split-ratio", nextRatio.toFixed(2));
      };

      const handlePointerUp = () => {
        cleanup();
      };

      splitResizeCleanupRef.current?.();
      splitResizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [],
  );

  if (showKanban) {
    return (
      <section className="main kanban-fullscreen">
        {kanbanNode}
        {globalRuntimeNoticeDockNode}
        {runtimeConsoleDockNode}
        {terminalDockNode}
      </section>
    );
  }

  const gitHistoryDockNode = showGitHistory ? (
    <div className="git-history-dock-overlay">
      <div
        className="git-history-dock-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("layout.resizeGitHistoryPanel")}
        onPointerDown={onGitHistoryPanelResizeStart}
      />
      <div className="git-history-dock-body">{gitHistoryNode}</div>
    </div>
  ) : null;

  return (
    <>
      {!settingsOpen && sidebarNode}
      {!settingsOpen && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("layout.resizeSidebar")}
          onMouseDown={onSidebarResizeStart}
        />
      )}

      <section
        className={`main${settingsOpen ? " settings-open" : ""}${
          hideRightPanel ? " spec-focus" : ""
        }`}
        style={settingsOpen ? { gridColumn: "1 / -1" } : undefined}
      >
        {errorToastsNode}
        {globalRuntimeNoticeDockNode}

        {settingsOpen && settingsNode}

        {!settingsOpen && isMemoryMode && (
          <div
            ref={memoryLayerRef}
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
          >
            <MemoryPanel />
          </div>
        )}

        {!settingsOpen && !isMemoryMode && (
          <>
            {updateToastNode}
            {showHome && homeNode}
            {showHome ? rightPanelNode : null}
            {showHome ? rightPanelCollapsedNode : null}

            {showWorkspace && !showHome && (
              <>
                <MainTopbar leftNode={topbarLeftNode} />
                {approvalToastsNode}
                <div
                  className={`content${isEditorSplitMode ? " is-editor-split" : ""}${
                    isBrowserDockSplitVisible ? " is-browser-dock-split" : ""
                  }${
                    isEditorSplitMode
                      ? isEditorHorizontalSplitMode
                        ? " is-editor-split-horizontal"
                        : " is-editor-split-vertical"
                      : ""
                  }${
                    isEditorSplitMode && isEditorFileMaximized
                      ? " is-editor-file-maximized"
                      : ""
                  }`}
                >
                  <div
                    className={`content-layer content-layer--diff ${
                      centerMode === "diff" ? "is-active" : "is-hidden"
                    }`}
                    aria-hidden={centerMode !== "diff"}
                    ref={diffLayerRef}
                  >
                    {gitDiffViewerNode}
                  </div>
                  <div
                    className={`content-layer content-layer--editor ${
                      centerMode === "editor" ? "is-active" : "is-hidden"
                    }`}
                    aria-hidden={centerMode !== "editor"}
                    ref={editorLayerRef}
                  >
                    {fileViewPanelNode}
                  </div>
                  {isEditorHorizontalSplitMode ? (
                    <div
                      className="content-editor-split-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t("layout.resizeEditorSplit")}
                      onPointerDown={handleHorizontalSplitPointerDown}
                    />
                  ) : null}
                  <div
                    className={`content-layer content-layer--project-map ${
                      centerMode === "projectMap" || isEditorSplitProjectMapVisible
                        ? "is-active"
                        : "is-hidden"
                    }${
                      isEditorSplitProjectMapVisible
                        ? " content-layer--editor-companion"
                        : ""
                    }`}
                    aria-hidden={centerMode !== "projectMap" && !isEditorSplitProjectMapVisible}
                    ref={projectMapLayerRef}
                  >
                    {projectMapPanelNode}
                  </div>
                  <div
                    className={`content-layer content-layer--intent-canvas ${
                      centerMode === "intentCanvas" ? "is-active" : "is-hidden"
                    }`}
                    aria-hidden={centerMode !== "intentCanvas"}
                    ref={intentCanvasLayerRef}
                  >
                    {intentCanvasPanelNode}
                  </div>
                  <div
                    className={`content-layer content-layer--chat ${
                      centerMode === "chat" || isEditorSplitChatVisible
                        ? "is-active"
                        : "is-hidden"
                    }${
                      isEditorSplitChatVisible ? " content-layer--editor-companion" : ""
                    }`}
                    aria-hidden={centerMode !== "chat" && !isEditorSplitChatVisible}
                    ref={chatLayerRef}
                  >
                    {messagesNode}
                    {shouldPlaceComposerInChatColumn ? composerNode : null}
                  </div>
                  {isBrowserDockSplitVisible ? (
                    <div
                      className="content-browser-dock-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t("layout.resizeEditorSplit")}
                      onPointerDown={handleBrowserDockSplitPointerDown}
                    />
                  ) : null}
                  <div
                    className={`content-layer content-layer--browser-dock ${
                      isBrowserDockSplitVisible
                        ? "is-active content-layer--browser-companion"
                        : "is-hidden"
                    }`}
                    aria-hidden={!isBrowserDockSplitVisible}
                  >
                    {browserDockNode}
                  </div>
                </div>

                {rightPanelNode}
                {rightPanelCollapsedNode}
                {shouldShowComposerBelowContent ? composerNode : null}
                {runtimeConsoleDockNode}
                {terminalDockNode}
                {debugPanelNode}
                {gitHistoryDockNode}
              </>
            )}
            {!showWorkspace && gitHistoryDockNode}
          </>
        )}
      </section>
    </>
  );
}
