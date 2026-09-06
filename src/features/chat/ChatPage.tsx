import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import {
  AiChatSidebar,
  type AiChatRepo,
  type ThreadAction,
} from "@/components/application/ai-chat/ai-chat-sidebar";
import { useChatStore, sessionKey } from "./store";
import { SessionTabStrip } from "./components/SessionTabStrip";
import { ChatConversation } from "./components/ChatConversation";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { relativeTime } from "./time";
import { ChangesPanel } from "@/features/git/ChangesPanel";
import { AppStatusBar } from "@/components/application/app-status-bar/app-status-bar";
import { FilesPanel } from "@/features/files/FilesPanel";
import { fileName, useFilesStore } from "@/features/files/store";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { ConfirmDialog, PromptDialog } from "@/components/dialogs";
import { CenteredSpinner } from "@/components/base/empty-state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Folder from "lucide-react/dist/esm/icons/folder";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open";
import { HeaderOpenActions } from "@/features/open-app/HeaderOpenActions";
import { TerminalDock } from "@/features/terminal/TerminalDock";
import { useTerminalStore } from "@/features/terminal/store";
import { useGitStore } from "@/features/git/store";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { readStoredBool, readStoredNumber, writeStored } from "@/lib/storage";
import { cx } from "@/utils/cx";

// File tabs share the session tab strip; their keys are prefixed so select /
// close handlers can route them to the files store instead of the chat store.
const FILE_TAB_PREFIX = "file:";
// CodeMirror + react-markdown are heavy; split them out of the startup chunk.
const EditorPane = lazy(() => import("@/features/files/EditorPane"));
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 560;
// Open at the narrowest usable width; users can widen via the resize grip.
const PANEL_DEFAULT_WIDTH = PANEL_MIN_WIDTH;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 260;
const PANEL_COLLAPSED_KEY = "ccgui-next.panelCollapsed";
const SIDEBAR_COLLAPSED_KEY = "ccgui-next.sidebarCollapsed";
const PANEL_WIDTH_KEY = "ccgui-next.panelWidth";
const SIDEBAR_WIDTH_KEY = "ccgui-next.sidebarWidth";

/** Stored width, validated against the live min/max before use. */
function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  const raw = readStoredNumber(key, fallback);
  return raw >= min && raw <= max ? raw : fallback;
}
const PANEL_TOGGLE_CLASSES = cx(
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
);

export default function ChatPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // Store actions are stable references — one shallow subscription for all.
  const {
    init,
    selectSession,
    startNewChat,
    addWorkspace,
    reorderWorkspaces,
    removeWorkspace,
    pinSession,
    renameSession,
    deleteSession,
    closeTab,
    focusTab,
  } = useChatStore(
    useShallow((s) => ({
      init: s.init,
      selectSession: s.selectSession,
      startNewChat: s.startNewChat,
      addWorkspace: s.addWorkspace,
      reorderWorkspaces: s.reorderWorkspaces,
      removeWorkspace: s.removeWorkspace,
      pinSession: s.pinSession,
      renameSession: s.renameSession,
      deleteSession: s.deleteSession,
      closeTab: s.closeTab,
      focusTab: s.focusTab,
    })),
  );
  // Sidebar/tab-strip data: low-frequency slices that change only on
  // navigation or a list refresh. High-frequency session/draft subscriptions
  // live in ChatConversation (components/ChatConversation.tsx).
  const { active, workspaces, sessions, engines, openTabs, threadLimit } = useChatStore(
    useShallow((s) => ({
      active: s.active,
      workspaces: s.workspaces,
      sessions: s.sessions,
      engines: s.engines,
      openTabs: s.openTabs,
      threadLimit: s.threadLimit,
    })),
  );
  const gitRefresh = useGitStore((s) => s.refresh);
  // Terminal dock: toggled from the header open-actions cluster (and ⌘J).
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const removeTerminalWorkspace = useTerminalStore((s) => s.removeWorkspace);
  // Flat streaming map: its reference changes only when a session actually
  // starts/stops streaming, so these selectors do not rescan bySession on
  // every per-frame stream flush.
  const streamingByKey = useChatStore((s) => s.streamingByKey);
  // Per-tab streaming flags for the tab strip; recomputed only when a flag
  // actually flips (or the tab list changes).
  const tabStreaming = useMemo(
    () =>
      openTabs.map(
        (tab) => streamingByKey[sessionKey(tab.engine, tab.sessionId, tab.workspacePath)] === true,
      ),
    [openTabs, streamingByKey],
  );
  // Sidebar status dots: per-thread streaming flags plus the unseen map
  // (reference-stable until a flag actually changes).
  const threadStreaming = useMemo(
    () =>
      sessions.map(
        (sess) =>
          streamingByKey[sessionKey(sess.engine, sess.sessionId, sess.workspacePath)] === true,
      ),
    [sessions, streamingByKey],
  );
  const unseen = useChatStore((s) => s.unseen);
  const actionError = useChatStore((s) => s.actionError);
  const dismissActionError = useChatStore((s) => s.dismissActionError);
  const [panelWidth, setPanelWidth] = useState(() => readStoredWidth(PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_DEFAULT_WIDTH));
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => readStoredBool(PANEL_COLLAPSED_KEY, false),
  );
  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => {
      writeStored(PANEL_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStoredBool(SIDEBAR_COLLAPSED_KEY, false),
  );
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeStored(SIDEBAR_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const [dragging, setDragging] = useState<"sidebar" | "panel" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH));
  const [panelTab, setPanelTab] = useState<"files" | "changes">("files");
  // Open file tabs render alongside the session tabs in the center area.
  const { openFiles, activeFilePath, dirtyPaths, activateFile, clearActiveFile, closeFile } =
    useFilesStore(
      useShallow((s) => ({
        openFiles: s.openFiles,
        activeFilePath: s.activeFilePath,
        dirtyPaths: s.dirtyPaths,
        activateFile: s.activateFile,
        clearActiveFile: s.clearActiveFile,
        closeFile: s.closeFile,
      })),
    );
  const [dialog, setDialog] = useState<
    | { kind: "rename"; session: SessionMeta }
    | { kind: "delete"; session: SessionMeta }
    | { kind: "removeWorkspace"; workspaceId: string }
    | { kind: "closeFile"; path: string }
    | null
  >(null);
  const widthAtDragStart = useRef(PANEL_DEFAULT_WIDTH);
  const dragStartX = useRef(0);
  const dragWidth = useRef(PANEL_DEFAULT_WIDTH);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelHeaderRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<ComposerInputHandle>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Refocus rescan: 5min TTL, aligned with TokenTracker tier-1.
  useEffect(() => {
    let lastScan = Date.now();
    const onFocus = () => {
      if (Date.now() - lastScan > 5 * 60_000) {
        lastScan = Date.now();
        void ipc.rescanSessions().catch(() => {});
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Git status follows the active workspace (30s TTL inside the store).
  useEffect(() => {
    if (active?.workspacePath) void gitRefresh(active.workspacePath);
  }, [active?.workspacePath, gitRefresh]);
  // ⌘J / Ctrl+J toggles the terminal dock for the active workspace.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "j"
      ) {
        if (!active) return;
        e.preventDefault();
        toggleTerminal(active.workspacePath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, toggleTerminal]);

  // Both edges resize the same way: press anywhere on the full-height strip,
  // drag, release. Width is mutated directly during the drag; committing to
  // state once on pointerup avoids a re-render per pointermove.
  const handleResizeStart = useCallback(
    (target: "sidebar" | "panel") => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      widthAtDragStart.current = target === "panel" ? panelWidth : sidebarWidth;
      dragWidth.current = widthAtDragStart.current;
      dragStartX.current = e.clientX;
      setDragging(target);
    },
    [panelWidth, sidebarWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    const isPanel = dragging === "panel";
    const sized = isPanel ? panelRef.current : sidebarRef.current;
    const resizer = isPanel ? null : sidebarResizerRef.current;
    // The panel's titlebar header tracks live drags so its border never
    // lags the panel edge on pointerup.
    const header = isPanel ? panelHeaderRef.current : null;
    const min = isPanel ? PANEL_MIN_WIDTH : SIDEBAR_MIN_WIDTH;
    const max = isPanel ? PANEL_MAX_WIDTH : SIDEBAR_MAX_WIDTH;
    const onMove = (e: PointerEvent) => {
      // The panel grows leftward, the sidebar rightward.
      const delta = isPanel
        ? dragStartX.current - e.clientX
        : e.clientX - dragStartX.current;
      const next = Math.min(max, Math.max(min, widthAtDragStart.current + delta));
      dragWidth.current = next;
      if (sized) sized.style.width = `${next}px`;
      if (resizer) resizer.style.left = `${next}px`;
      if (header) header.style.width = `${next}px`;
    };
    const onUp = () => {
      setDragging(null);
      // Persist once on release; mid-drag writes would thrash storage.
      if (isPanel) {
        setPanelWidth(dragWidth.current);
        writeStored(PANEL_WIDTH_KEY, dragWidth.current);
      } else {
        setSidebarWidth(dragWidth.current);
        writeStored(SIDEBAR_WIDTH_KEY, dragWidth.current);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  // ---------- sidebar data ----------
  const sessionById = useMemo(() => {
    const map = new Map<string, SessionMeta>();
    for (const s of sessions) map.set(`${s.engine}/${s.sessionId}`, s);
    return map;
  }, [sessions]);
  // ---------- tab strip ----------
  const sessionTabItems = useMemo(
    () =>
      openTabs.map((tab, index) => {
        const meta = tab.sessionId
          ? sessionById.get(`${tab.engine}/${tab.sessionId}`)
          : undefined;
        return {
          key: sessionKey(tab.engine, tab.sessionId, tab.workspacePath),
          engine: tab.engine,
          label: meta?.customTitle || meta?.title || t("chat.newChat"),
          streaming: tabStreaming[index] ?? false,
          unseen: unseen[`${tab.engine}/${tab.sessionId}`] ?? false,
          tab,
        };
      }),
    [openTabs, sessionById, tabStreaming, t, unseen],
  );
  // File tabs trail the session tabs in the same strip.
  const fileTabItems = useMemo(
    () =>
      openFiles.map((path) => ({
        key: FILE_TAB_PREFIX + path,
        label: fileName(path),
        title: path,
        icon: FileText,
        streaming: false,
        dirty: !!dirtyPaths[path],
      })),
    [openFiles, dirtyPaths],
  );
  const tabItems = useMemo(
    () => [...sessionTabItems, ...fileTabItems],
    [sessionTabItems, fileTabItems],
  );
  const activeTabKey = activeFilePath
    ? FILE_TAB_PREFIX + activeFilePath
    : active
      ? sessionKey(active.engine, active.sessionId, active.workspacePath)
      : null;
  const handleTabSelect = useCallback(
    (tabKey: string) => {
      if (tabKey.startsWith(FILE_TAB_PREFIX)) {
        activateFile(tabKey.slice(FILE_TAB_PREFIX.length));
        return;
      }
      clearActiveFile();
      const item = sessionTabItems.find((i) => i.key === tabKey);
      if (item) focusTab(item.tab.engine, item.tab.sessionId, item.tab.workspacePath);
    },
    [sessionTabItems, focusTab, activateFile, clearActiveFile],
  );
  const handleTabClose = useCallback(
    (tabKey: string) => {
      if (tabKey.startsWith(FILE_TAB_PREFIX)) {
        const path = tabKey.slice(FILE_TAB_PREFIX.length);
        if (dirtyPaths[path]) setDialog({ kind: "closeFile", path });
        else closeFile(path);
        return;
      }
      const item = sessionTabItems.find((i) => i.key === tabKey);
      if (item) closeTab(item.tab.engine, item.tab.sessionId, item.tab.workspacePath);
    },
    [sessionTabItems, closeTab, closeFile, dirtyPaths],
  );

  const repos: AiChatRepo[] = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
    const streamingById = new Map<string, boolean>();
    sessions.forEach((s, i) => {
      if (threadStreaming[i]) streamingById.set(`${s.engine}/${s.sessionId}`, true);
    });
    return workspaces.map((w, index) => ({
      id: w.id,
      label: w.name,
      defaultOpen: index === 0,
      threadLimit,
      threads: sorted
        .filter((s) => s.workspacePath === w.path)
        .map((s) => ({
          id: `${s.engine}/${s.sessionId}`,
          label: s.customTitle || s.title || s.sessionId.slice(0, 8),
          engine: s.engine,
          time: relativeTime(s.updatedAt),
          pinned: s.pinned,
          streaming: streamingById.get(`${s.engine}/${s.sessionId}`) ?? false,
          unseen: unseen[`${s.engine}/${s.sessionId}`] ?? false,
        })),
    }));
  }, [workspaces, sessions, threadLimit, threadStreaming, unseen, i18n.language]);

  const handleAddWorkspace = useCallback(() => {
    void openDialog({ directory: true, multiple: false, title: t("chat.addWorkspace") })
      .then((selected) => {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) void addWorkspace(path);
      })
      .catch(() => {});
  }, [t, addWorkspace]);

  const handleThreadSelect = useCallback(
    (id: string) => {
      const session = sessionById.get(id);
      if (session) void selectSession(session.engine, session.sessionId, session.workspacePath);
    },
    [sessionById, selectSession],
  );

  const handleThreadAction = useCallback(
    (id: string, action: ThreadAction) => {
      const session = sessionById.get(id);
      if (!session) return;
      if (action === "pin") {
        void pinSession(session.engine, session.sessionId, !session.pinned);
      } else if (action === "rename") {
        setDialog({ kind: "rename", session });
      } else if (action === "delete") {
        setDialog({ kind: "delete", session });
      }
    },
    [sessionById, pinSession],
  );
  const handleRemoveWorkspace = useCallback((workspaceId: string) => {
    setDialog({ kind: "removeWorkspace", workspaceId });
  }, []);

  // Sidebar 新建会话 nav entry: new chat in the active workspace (fallback:
  // first workspace; no workspace yet → add one first).
  const handleNewSession = useCallback(() => {
    const workspace =
      workspaces.find((w) => w.path === active?.workspacePath) ?? workspaces[0];
    if (!workspace) {
      handleAddWorkspace();
      return;
    }
    startNewChat(workspace.path);
    composerInputRef.current?.focus();
  }, [workspaces, active?.workspacePath, startNewChat, handleAddWorkspace]);

  // Workspace row + button: start (or re-focus) the pending new chat in that
  // workspace.
  const handleNewSessionInWorkspace = useCallback(
    (workspaceId: string) => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;
      startNewChat(workspace.path);
      composerInputRef.current?.focus();
    },
    [workspaces, startNewChat],
  );
  const handleReorderWorkspaces = useCallback(
    (orderedIds: string[]) => void reorderWorkspaces(orderedIds),
    [reorderWorkspaces],
  );

  return (
    <div
      className={cx(
        "relative flex h-dvh w-full overflow-hidden bg-background-full",
        dragging && "cursor-col-resize select-none",
      )}
    >
      <AiChatSidebar
        width={sidebarCollapsed ? 0 : sidebarWidth}
        rootRef={sidebarRef}
        className={cx(
          // Width transition for collapse/expand; disabled mid-drag since
          // resizes mutate style.width imperatively per pointermove.
          !dragging &&
            "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          sidebarCollapsed && "border-r-0",
        )}
        repos={repos}
        activeThreadId={active?.sessionId ? `${active.engine}/${active.sessionId}` : undefined}
        onThreadSelect={handleThreadSelect}
        onThreadAction={handleThreadAction}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={handleRemoveWorkspace}
        onNewSessionInWorkspace={handleNewSessionInWorkspace}
        onNewSession={handleNewSession}
        onReorderWorkspaces={handleReorderWorkspaces}
        onOpenSettings={() => navigate("/settings")}
        onClose={toggleSidebarCollapsed}
      />
      {/* Sidebar resize strip: full height, straddling the border. */}
      {!sidebarCollapsed && (
        <div
          ref={sidebarResizerRef}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chat.resizeSidebar")}
          title={t("chat.resizeSidebar")}
          onPointerDown={handleResizeStart("sidebar")}
          className="group absolute inset-y-0 z-30 w-2 -translate-x-1/2 cursor-col-resize touch-none"
          style={{ left: sidebarWidth }}
        >
          <span
            className={cx(
              "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-300 opacity-0 transition-opacity group-hover:opacity-100",
              dragging === "sidebar" && "opacity-100",
            )}
          />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <SessionTabStrip
          tabs={tabItems}
          activeKey={activeTabKey}
          onSelect={handleTabSelect}
          onClose={handleTabClose}
          closeLabel={t("common.close")}
          trafficLightInset={sidebarCollapsed}
          leading={
            sidebarCollapsed ? (
              <button
                type="button"
                title={t("chat.expandSidebar")}
                aria-label={t("chat.expandSidebar")}
                onClick={toggleSidebarCollapsed}
                className={PANEL_TOGGLE_CLASSES}
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </button>
            ) : undefined
          }
          actions={
            active ? (
              <div className="flex h-full items-center">
                <HeaderOpenActions workspacePath={active.workspacePath} />
                <div className="hidden h-full items-center xl:flex">
                  {
                    // Panel header lives in the titlebar: same width as the
                    // panel below, border-l continuing the panel's left edge.
                    // Always mounted so width animates in sync with the panel.
                    <div
                      ref={panelHeaderRef}
                      className={cx(
                        "flex h-full items-center justify-end overflow-hidden",
                        // Width is mutated imperatively during panel drags.
                        !dragging &&
                          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
                        !panelCollapsed && "border-l border-separator-border",
                      )}
                      style={{ width: panelCollapsed ? 0 : panelWidth }}
                    >
                    <div
                      className="flex h-full shrink-0 items-center gap-2 px-3"
                      style={{ width: panelWidth }}
                    >
                      <PillTabList>
                        <PillTab
                          icon={Folder}
                          isSelected={panelTab === "files"}
                          onSelect={() => setPanelTab("files")}
                        >
                          {t("files.tab")}
                        </PillTab>
                        <PillTab
                          icon={GitBranch}
                          isSelected={panelTab === "changes"}
                          onSelect={() => setPanelTab("changes")}
                        >
                          {t("git.changes")}
                        </PillTab>
                      </PillTabList>
                      <button
                        type="button"
                        title={t("openApp.collapsePanel")}
                        aria-label={t("openApp.collapsePanel")}
                        onClick={togglePanelCollapsed}
                        className={cx(PANEL_TOGGLE_CLASSES, "ml-auto")}
                      >
                        <PanelRightClose className="size-4" aria-hidden />
                      </button>
                    </div>
                    </div>
                  }
                  {panelCollapsed && (
                    <button
                      type="button"
                      title={t("openApp.expandPanel")}
                      aria-label={t("openApp.expandPanel")}
                      onClick={togglePanelCollapsed}
                      className={cx(PANEL_TOGGLE_CLASSES, "mx-1.5")}
                    >
                      <PanelRightOpen className="size-4" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
            ) : undefined
          }
        />

        {actionError && (
          <div
            role="alert"
            className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary"
          >
            <span className="min-w-0 flex-1 break-all">
              {t("common.error")}: {actionError}
            </span>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={dismissActionError}
              className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-background-tertiary-hover"
            >
              ×
            </button>
          </div>
        )}

        <div
          id="center-tabpanel"
          role="tabpanel"
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {/* Chat and file editors share the center pane. The inactive surface
              stays mounted but invisible (never display:none) so WKWebView
              keeps its scroll boxes and editor drafts alive — see the
              virtualizer note in FileTree. */}
          <div
            className={cx(
              "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
              activeFilePath
                ? "invisible absolute inset-0"
                : "relative min-w-0 flex-1 basis-0",
            )}
          >
            <ChatConversation
              active={active}
              engines={engines}
              workspaces={workspaces}
              startNewChat={startNewChat}
              composerInputRef={composerInputRef}
            />
          </div>

          {openFiles.length > 0 && (
            <div
              className={cx(
                "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
                activeFilePath
                  ? "relative min-w-0 flex-1 basis-0"
                  : "invisible absolute inset-0",
              )}
            >
              <Suspense fallback={<CenteredSpinner />}>
                {openFiles.map((path) => (
                  <div
                    key={path}
                    className={cx(
                      "min-h-0 flex-col",
                      path === activeFilePath
                        ? "flex flex-1"
                        : "invisible absolute inset-0",
                    )}
                  >
                    <EditorPane path={path} />
                  </div>
                ))}
              </Suspense>
            </div>
          )}
          
          {active && (
            <div
              ref={panelRef}
              className={cx(
                "relative hidden shrink-0 overflow-hidden xl:flex",
                // Width transition for collapse/expand; disabled mid-drag
                // since resizes mutate style.width imperatively.
                !dragging &&
                  "transition-[width] duration-200 ease-out motion-reduce:transition-none",
              )}
              style={{ width: panelCollapsed ? 0 : panelWidth }}
            >
              {/* Panel resize strip: full height, straddling the border. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("chat.resizePanel")}
                title={t("chat.resizePanel")}
                onPointerDown={handleResizeStart("panel")}
                className={cx(
                  "group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none",
                  panelCollapsed && "hidden",
                )}
              >
                <span
                  className={cx(
                    "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-300 opacity-0 transition-opacity group-hover:opacity-100",
                    dragging === "panel" && "opacity-100",
                  )}
                />
              </div>
              <div
                className={cx(
                  "flex h-full w-full flex-col overflow-hidden border-separator-border bg-background-primary-default",
                  !panelCollapsed && "border-l",
                )}
              >
                {/* Both panels stay mounted so tab switches preserve tree
                    expansion and diff state. */}
                <div
                  className={cx(
                    "min-h-0 flex-1",
                    panelTab === "files" ? "flex flex-col" : "hidden",
                  )}
                >
                  <FilesPanel workspacePath={active.workspacePath} />
                </div>
                <div
                  className={cx(
                    "min-h-0 flex-1",
                    panelTab === "changes" ? "flex flex-col" : "hidden",
                  )}
                >
                  <ChangesPanel key={active.workspacePath} workspacePath={active.workspacePath} className="w-full" />
                </div>
              </div>
            </div>
          )}
        </div>
        {active && <TerminalDock workspacePath={active.workspacePath} />}
        <AppStatusBar />
      </div>

      {dialog?.kind === "rename" && (
        <PromptDialog
          title={t("chat.renameSession")}
          initial={dialog.session.customTitle || dialog.session.title}
          onSubmit={(title) => {
            setDialog(null);
            void renameSession(dialog.session.engine, dialog.session.sessionId, title);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          danger
          message={t("chat.confirmDeleteSession")}
          onConfirm={() => {
            setDialog(null);
            void deleteSession(dialog.session.engine, dialog.session.sessionId);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "closeFile" && (
        <ConfirmDialog
          danger
          message={t("files.confirmCloseDirty", { name: fileName(dialog.path) })}
          onConfirm={() => {
            closeFile(dialog.path);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "removeWorkspace" && (
        <ConfirmDialog
          message={t("chat.confirmRemoveWorkspace")}
          onConfirm={() => {
            const workspace = workspaces.find((w) => w.id === dialog.workspaceId);
            if (workspace) removeTerminalWorkspace(workspace.path);
            setDialog(null);
            void removeWorkspace(dialog.workspaceId);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
