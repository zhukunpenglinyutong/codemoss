import { create } from "zustand";
import { ipc, type AppSettings, type Message, type SessionMeta, type Workspace, type EngineInfo } from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { listenEngineEvents, listenSessionsChanged } from "@/lib/events";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";
import {
  ENGINE_PREF_KEY,
  persistTabs,
  readPersistedActive,
  readPersistedTabs,
  sameTab,
  sessionKey,
  type ActiveSession,
} from "./store/persistence";
import {
  EMPTY_SESSION,
  applyStreamParts,
  drainPending,
  moveStreamingFlag,
  patchSession,
  runRouting,
  setStreamingFlag,
  settleLiveRows,
  type SessionState,
} from "./store/stream";
import {
  firstLineTitle,
  handleEngineEvents,
  optimisticMeta,
  upsertSessionMetaInto,
} from "./store/engine-events";

// Facade re-exports: callers keep importing everything from "../store".
export { sessionKey } from "./store/persistence";
export type { ActiveSession } from "./store/persistence";
export type { QueuedMessage, SessionState } from "./store/stream";

/** Unlisteners for the module-scope event subscriptions set up in init. */
const eventTeardowns: Array<() => void> = [];

export interface ChatStore {
  workspaces: Workspace[];
  sessions: SessionMeta[];
  engines: EngineInfo[];
  active: ActiveSession | null;
  /** Open conversation tabs, in display order. Persisted in localStorage. */
  openTabs: ActiveSession[];
  activeEngine: string;
  /** Per-engine reasoning effort ("low" | … | "max"), persisted in app settings. */
  efforts: Record<string, EffortLevel>;
  /** Per-engine model override ("" = CLI/provider default), persisted in app settings. */
  models: Record<string, string>;
  /** Max sessions listed per workspace in the sidebar, persisted in app settings. */
  threadLimit: number;
  /** Composer send gesture ("enter" | "cmdEnter"), persisted in app settings. */
  sendShortcut: string;
  bySession: Record<string, SessionState>;
  /** Flat sessionKey -> streaming map, written only when a flag flips. The
   * tab strip and sidebar select this instead of scanning bySession on every
   * store write (streaming deltas would otherwise re-render them per frame). */
  streamingByKey: Record<string, true>;
  /** Sessions with activity the user has not opened yet (sidebar green dot),
   * keyed `${engine}/${sessionId}` like the sidebar thread id. In-memory only. */
  unseen: Record<string, boolean>;
  drafts: Record<string, string>;
  /** File-tree "+" click asking the active composer to insert an @path
   * mention; nonce re-fires for the same path. */
  pendingMention: { path: string; nonce: number } | null;
  /** Last failed store action (add/remove workspace, delete/pin/rename
   * session); surfaced as a dismissable banner in ChatPage. */
  actionError: string | null;
  initialized: boolean;

  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  addWorkspace: (path: string) => Promise<void>;
  reorderWorkspaces: (ids: string[]) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;
  selectSession: (engine: string, sessionId: string, workspacePath: string) => Promise<void>;
  closeTab: (engine: string, sessionId: string | null, workspacePath: string) => void;
  /** Activate an already-open tab without changing the tab list. */
  focusTab: (engine: string, sessionId: string | null, workspacePath: string) => void;
  startNewChat: (workspacePath: string) => void;
  setActiveEngine: (engine: string) => void;
  setEffort: (engine: string, effort: EffortLevel) => Promise<void>;
  setModel: (engine: string, model: string) => Promise<void>;
  /** Pin several engines' models at once (startup defaulting); one settings
   * write instead of one per engine. */
  pinModels: (updates: Record<string, string>) => Promise<void>;
  setThreadLimit: (limit: number) => void;
  setSendShortcut: (shortcut: string) => void;
  setDraft: (key: string, text: string) => void;
  /** Ask the active composer to insert an @path mention at the caret. */
  requestMention: (path: string) => void;
  clearPendingMention: () => void;
  dismissActionError: () => void;
  loadEarlier: () => Promise<void>;
  send: (prompt: string, images: string[]) => Promise<void>;
  /** Enqueue a message on the active session while a turn streams. */
  queueMessage: (text: string, images: string[]) => void;
  /** Drop a queued message from the active session. */
  removeQueued: (id: string) => void;
  interrupt: () => Promise<void>;
  deleteSession: (engine: string, sessionId: string) => Promise<void>;
  pinSession: (engine: string, sessionId: string, pinned: boolean) => Promise<void>;
  renameSession: (engine: string, sessionId: string, title: string) => Promise<void>;
}

/** Persist one app-settings patch; callers have already applied the in-memory
 * value, so a persist failure is non-fatal. */
async function persistSettings(patch: (settings: AppSettings) => Partial<AppSettings>) {
  try {
    const settings = await ipc.getAppSettings();
    await ipc.updateAppSettings({ ...settings, ...patch(settings) });
  } catch {
    // Persist failure is non-fatal: the in-memory value still applies.
  }
}

function omitKey(rec: Record<string, boolean>, key: string) {
  const next = { ...rec };
  delete next[key];
  return next;
}

/** Append committed timeline rows, assigning seq after the session's last
 * row; `patch` carries any extra per-site session changes. */
function appendCommittedRows(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  rows: Omit<Message, "seq">[],
  patch: Partial<SessionState> = {},
) {
  set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const lastSeq = prev.messages.length ? prev.messages[prev.messages.length - 1].seq : 0;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          ...patch,
          messages: [...prev.messages, ...rows.map((row, i) => ({ ...row, seq: lastSeq + 1 + i }))],
        },
      },
    };
  });
}

export const useChatStore = create<ChatStore>((set, get) => {
  /** Activate a tab: existing sessions lazy-load via selectSession, pending chats just set. */
  function activateTab(tab: ActiveSession | null) {
    if (!tab) {
      set({ active: null });
      persistTabs(get().openTabs, null);
      return;
    }
    if (tab.sessionId) void get().selectSession(tab.engine, tab.sessionId, tab.workspacePath);
    else {
      // A pending tab sends with its own engine, so the picker must follow it
      // — otherwise the chip shows one CLI while sends go to another.
      const syncEngine = tab.engine !== get().activeEngine;
      if (syncEngine) writeStored(ENGINE_PREF_KEY, tab.engine);
      set(syncEngine ? { active: tab, activeEngine: tab.engine } : { active: tab });
      persistTabs(get().openTabs, tab);
    }
  }

  /** Remove a tab; when it was active, fall back to its nearest neighbor. */
  function removeTab(engine: string, sessionId: string | null, workspacePath: string) {
    const s = get();
    const idx = s.openTabs.findIndex((t) => sameTab(t, engine, sessionId, workspacePath));
    if (idx < 0) return;
    const openTabs = s.openTabs.filter((_, i) => i !== idx);
    set({ openTabs });
    if (s.active && sameTab(s.active, engine, sessionId, workspacePath)) {
      activateTab(openTabs[Math.min(idx, openTabs.length - 1)] ?? null);
    } else {
      persistTabs(openTabs, s.active);
    }
  }


  /**
   * Send a prompt to a specific tab. Unlike the public `send` action this is
   * not bound to the active session, so the queue can drain on a background
   * tab after its turn finishes there.
   */
  async function sendPrompt(tab: ActiveSession, prompt: string, images: string[]) {
    if (!prompt.trim() && images.length === 0) return;
    const engine = tab.engine;
    const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
    // Optimistic user message.
    set((s) => ({ streamingByKey: setStreamingFlag(s.streamingByKey, key, true) }));
    appendCommittedRows(
      set,
      key,
      [
        {
          role: "user",
          text: prompt,
          ts: new Date().toISOString(),
          images: images.length ? [...images] : undefined,
        },
      ],
      { streaming: true, error: null, interrupted: false, turnStartedAt: Date.now() },
    );
    try {
      const result = await ipc.sendMessage({
        engine,
        workspacePath: tab.workspacePath,
        sessionId: tab.sessionId,
        prompt,
        imagePaths: images.length ? images : null,
        model: get().models[engine] || null,
        effort: get().efforts[engine] ?? null,
      });
      if (result.sessionId && !tab.sessionId) {
        // Preassigned native id (grok): adopt immediately.
        set((s) => {
          const newKey = sessionKey(engine, result.sessionId, tab.workspacePath);
          const bySession = { ...s.bySession };
          if (bySession[key]) {
            bySession[newKey] = bySession[key];
            if (newKey !== key) delete bySession[key];
          }
          runRouting.set(result.runId, newKey);
          const openTabs = s.openTabs.map((t) =>
            t.engine === engine && t.sessionId === null && t.workspacePath === tab.workspacePath
              ? { ...t, sessionId: result.sessionId }
              : t,
          );
          // Only the active tab adopts the native id on `active`; a
          // background drain leaves the user's current tab untouched.
          const active =
            s.active &&
            s.active.engine === engine &&
            s.active.sessionId === null &&
            s.active.workspacePath === tab.workspacePath
              ? { ...s.active, sessionId: result.sessionId }
              : s.active;
          return {
            bySession,
            openTabs,
            active,
            streamingByKey: moveStreamingFlag(s.streamingByKey, key, newKey),
          };
        });
        persistTabs(get().openTabs, get().active);
        // Sidebar row + tab title pick the new session up immediately
        // instead of waiting for the post-turn rescan.
        upsertSessionMetaInto(
          set,
          optimisticMeta(engine, result.sessionId, tab.workspacePath, firstLineTitle(prompt)),
        );
      } else {
        runRouting.set(result.runId, key);
      }
    } catch (error) {
      set((s) => ({ streamingByKey: setStreamingFlag(s.streamingByKey, key, false) }));
      patchSession(set, key, { error: String(error), streaming: false, turnStartedAt: null });
    }
  }

  /** Flag a finished background session as unseen so the sidebar shows the
   * green dot until the user opens it; the watched active tab never flags. */
  function markUnseenIfBackground(key: string) {
    const active = get().active;
    const activeKey = active
      ? sessionKey(active.engine, active.sessionId, active.workspacePath)
      : null;
    if (key === activeKey) return;
    set((s) => (s.unseen[key] ? {} : { unseen: { ...s.unseen, [key]: true } }));
  }

  /** After a turn ends, send the oldest queued message for that session. */
  function drainQueue(key: string) {
    const s = get();
    const session = s.bySession[key];
    if (!session || session.streaming || session.queue.length === 0) return;
    const tab = s.openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
    if (!tab) return;
    const [head, ...rest] = session.queue;
    set((prev) => ({
      bySession: {
        ...prev.bySession,
        [key]: { ...(prev.bySession[key] ?? EMPTY_SESSION), queue: rest },
      },
    }));
    void sendPrompt(tab, head.text, head.images);
  }

  return {
    workspaces: [],
    sessions: [],
    engines: [],
    active: null,
    openTabs: [],
    activeEngine: localStorage.getItem(ENGINE_PREF_KEY) ?? "claude",
    efforts: {},
    models: {},
    threadLimit: 10,
    sendShortcut: "enter",
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
    pendingMention: null,
    actionError: null,
    initialized: false,

    init: async () => {
      if (get().initialized) return;
      set({ initialized: true });
      eventTeardowns.push(
        subscribeTauriEvent(() =>
          listenEngineEvents((events) =>
            handleEngineEvents(events, {
              set,
              get,
              drainQueue,
              markUnseenIfBackground,
              upsertSessionMeta: (meta) => upsertSessionMetaInto(set, meta),
            }),
          ),
        ),
        subscribeTauriEvent(() => listenSessionsChanged(() => void get().refreshSessions())),
      );
      const [workspaces, sessions, engines] = await Promise.all([
        ipc.listWorkspaces().catch(() => [] as Workspace[]),
        ipc.listSessions().catch(() => [] as SessionMeta[]),
        ipc.listEngines().catch(() => [] as EngineInfo[]),
      ]);
      set({ workspaces, sessions, engines });
      // Migrate a persisted engine pref whose engine no longer exists.
      if (engines.length > 0 && !engines.some((e) => e.id === get().activeEngine)) {
        get().setActiveEngine(engines.find((e) => e.available)?.id ?? engines[0].id);
      }
      // Restore persisted tabs; drop ones whose workspace/session is gone.
      const restoredTabs = readPersistedTabs().filter(
        (t) =>
          workspaces.some((w) => w.path === t.workspacePath) &&
          (t.sessionId === null ||
            sessions.some((s) => s.engine === t.engine && s.sessionId === t.sessionId)),
      );
      set({ openTabs: restoredTabs });
      const persistedActive = readPersistedActive();
      const activeTab =
        persistedActive &&
        restoredTabs.some((t) =>
          sameTab(t, persistedActive.engine, persistedActive.sessionId, persistedActive.workspacePath),
        )
          ? persistedActive
          : (restoredTabs[0] ?? null);
      if (activeTab) activateTab(activeTab);
      ipc
        .getAppSettings()
        .then((settings) =>
          set({
            efforts: (settings.defaultEfforts ?? {}) as Record<string, EffortLevel>,
            models: settings.defaultModels ?? {},
            threadLimit: settings.sidebarThreadLimit ?? 5,
            sendShortcut: settings.composerSendShortcut ?? "enter",
          }),
        )
        .catch(() => {});
    },

    refreshSessions: async () => {
      const sessions = await ipc.listSessions().catch(() => null);
      if (sessions) set({ sessions });
    },

    refreshWorkspaces: async () => {
      const workspaces = await ipc.listWorkspaces().catch(() => null);
      if (workspaces) set({ workspaces });
    },

    addWorkspace: async (path) => {
      try {
        await ipc.addWorkspace(path);
        await get().refreshWorkspaces();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    reorderWorkspaces: async (ids) => {
      // Optimistic: listed ids first in the given order, the rest keep their
      // relative order after them.
      const order = new Map(ids.map((id, index) => [id, index]));
      set((s) => ({
        workspaces: [...s.workspaces].sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        ),
      }));
      try {
        await ipc.reorderWorkspaces(ids);
      } catch {
        await get().refreshWorkspaces();
      }
    },

    removeWorkspace: async (id) => {
      try {
        const removedPath = get().workspaces.find((w) => w.id === id)?.path;
        await ipc.removeWorkspace(id);
        await get().refreshWorkspaces();
        set({ actionError: null });
        if (!removedPath) return;
        const openTabs = get().openTabs.filter((t) => t.workspacePath !== removedPath);
        set({ openTabs });
        const active = get().active;
        if (active && active.workspacePath === removedPath) {
          activateTab(openTabs[0] ?? null);
        } else {
          persistTabs(openTabs, active);
        }
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    selectSession: async (engine, sessionId, workspacePath) => {
      const key = sessionKey(engine, sessionId, workspacePath);
      set((s) => {
        const openTabs = s.openTabs.some((t) => sameTab(t, engine, sessionId, workspacePath))
          ? s.openTabs
          : [...s.openTabs, { engine, sessionId, workspacePath }];
        persistTabs(openTabs, { engine, sessionId, workspacePath });
        // Opening a session clears its unseen flag.
        const unseen = key in s.unseen ? omitKey(s.unseen, key) : s.unseen;
        return { openTabs, active: { engine, sessionId, workspacePath }, unseen };
      });
      const existing = get().bySession[key];
      if (existing && existing.messages.length > 0) return;
      patchSession(set, key, { loading: true });
      try {
        const page = await ipc.loadSessionPage(engine, sessionId, 100);
        patchSession(set, key, {
          messages: page.messages,
          nextBefore: page.nextBefore,
          loading: false,
          // Live "usage" events only cover fresh turns; a resumed session
          // adopts the newest usage snapshot carried by its history.
          usage: [...page.messages].reverse().find((m) => m.usage)?.usage ?? null,
        });
      } catch (error) {
        patchSession(set, key, { loading: false, error: String(error) });
      }
    },

    startNewChat: (workspacePath) => {
      // One pending chat per workspace+engine: re-focus it instead of
      // piling up empty "new" tabs.
      set((s) => {
        const existing = s.openTabs.find(
          (t) => t.sessionId === null && t.engine === s.activeEngine && t.workspacePath === workspacePath,
        );
        const tab: ActiveSession = existing ?? { engine: s.activeEngine, sessionId: null, workspacePath };
        const openTabs = existing ? s.openTabs : [...s.openTabs, tab];
        persistTabs(openTabs, tab);
        return { openTabs, active: tab };
      });
    },

    closeTab: (engine, sessionId, workspacePath) => {
      removeTab(engine, sessionId, workspacePath);
    },
    focusTab: (engine, sessionId, workspacePath) => {
      activateTab({ engine, sessionId, workspacePath });
    },

    setActiveEngine: (engine) => {
      writeStored(ENGINE_PREF_KEY, engine);
      set((s) => {
        const active = s.active;
        // A pending (never-sent) tab has no backend session yet, so it
        // follows the picker: retarget it to the newly selected engine.
        // Otherwise the chip shows the new CLI while sends still go to the
        // engine the tab was created with.
        if (!active || active.sessionId !== null || active.engine === engine) {
          return { activeEngine: engine };
        }
        const oldKey = sessionKey(active.engine, null, active.workspacePath);
        // First turn still in flight (native id not yet assigned): event
        // routing is keyed to the old engine, so leave the tab untouched.
        if (s.bySession[oldKey]?.streaming) return { activeEngine: engine };
        const newKey = sessionKey(engine, null, active.workspacePath);
        const existing = s.openTabs.find(
          (t) =>
            !sameTab(t, active.engine, active.sessionId, active.workspacePath) &&
            t.sessionId === null &&
            t.engine === engine &&
            t.workspacePath === active.workspacePath,
        );
        // Carry unsent drafts / session state over to the new key.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        if (bySession[oldKey] && !bySession[newKey]) bySession[newKey] = bySession[oldKey];
        delete bySession[oldKey];
        if (drafts[oldKey] !== undefined && drafts[newKey] === undefined) {
          drafts[newKey] = drafts[oldKey];
        }
        delete drafts[oldKey];
        let openTabs: ActiveSession[];
        let nextActive: ActiveSession;
        if (existing) {
          // A pending tab for this engine+workspace already exists: fold
          // into it instead of stacking a duplicate.
          openTabs = s.openTabs.filter(
            (t) => !sameTab(t, active.engine, active.sessionId, active.workspacePath),
          );
          nextActive = existing;
        } else {
          nextActive = { ...active, engine };
          openTabs = s.openTabs.map((t) =>
            sameTab(t, active.engine, active.sessionId, active.workspacePath) ? nextActive : t,
          );
        }
        persistTabs(openTabs, nextActive);
        return {
          activeEngine: engine,
          openTabs,
          active: nextActive,
          bySession,
          drafts,
          streamingByKey: moveStreamingFlag(s.streamingByKey, oldKey, newKey),
        };
      });
    },
    setEffort: async (engine, effort) => {
      set({ efforts: { ...get().efforts, [engine]: effort } });
      await persistSettings((settings) => ({
        defaultEfforts: { ...settings.defaultEfforts, [engine]: effort },
      }));
    },
    setModel: async (engine, model) => {
      const models = { ...get().models };
      if (model) models[engine] = model;
      else delete models[engine];
      set({ models });
      await persistSettings((settings) => {
        const defaultModels = { ...settings.defaultModels };
        if (model) defaultModels[engine] = model;
        else delete defaultModels[engine];
        return { defaultModels };
      });
    },
    pinModels: async (updates) => {
      const entries = Object.entries(updates).filter(([, model]) => model.trim());
      if (entries.length === 0) return;
      const models = { ...get().models };
      for (const [engine, model] of entries) models[engine] = model;
      set({ models });
      await persistSettings((settings) => ({
        defaultModels: { ...settings.defaultModels, ...Object.fromEntries(entries) },
      }));
    },

    setThreadLimit: (limit) => {
      set({ threadLimit: Math.max(1, Math.floor(limit)) });
    },
    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
    },

    setDraft: (key, text) => {
      set((s) => ({ drafts: { ...s.drafts, [key]: text } }));
    },
    requestMention: (path) => {
      set((s) => ({ pendingMention: { path, nonce: (s.pendingMention?.nonce ?? 0) + 1 } }));
    },

    clearPendingMention: () => {
      set({ pendingMention: null });
    },

    dismissActionError: () => {
      set({ actionError: null });
    },

    loadEarlier: async () => {
      const { active, bySession } = get();
      if (!active?.sessionId) return;
      const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
      const state = bySession[key];
      if (!state?.nextBefore || state.loading) return;
      patchSession(set, key, { loading: true });
      try {
        const page = await ipc.loadSessionPage(
          active.engine,
          active.sessionId,
          100,
          state.nextBefore,
        );
        patchSession(set, key, {
          messages: [...page.messages, ...(get().bySession[key] ?? EMPTY_SESSION).messages],
          nextBefore: page.nextBefore,
          loading: false,
        });
      } catch {
        patchSession(set, key, { loading: false });
      }
    },

    send: async (prompt, images) => {
      const { active } = get();
      if (active) await sendPrompt(active, prompt, images);
    },

    queueMessage: (text, images) => {
      const { active } = get();
      if (!active || (!text.trim() && images.length === 0)) return;
      const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
      set((s) => {
        const prev = s.bySession[key] ?? EMPTY_SESSION;
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...prev,
              queue: [
                ...prev.queue,
                { id: crypto.randomUUID(), text, images, queuedAt: Date.now() },
              ],
            },
          },
        };
      });
    },

    removeQueued: (id) => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
      set((s) => {
        const prev = s.bySession[key];
        if (!prev) return {};
        return {
          bySession: {
            ...s.bySession,
            [key]: { ...prev, queue: prev.queue.filter((item) => item.id !== id) },
          },
        };
      });
    },

    interrupt: async () => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
      // Registry is keyed by native session id once known; before that the
      // run id routes. Try both.
      if (active.sessionId) await ipc.interruptSession(active.sessionId).catch(() => false);
      for (const [runId, routed] of runRouting) {
        if (routed === key) {
          await ipc.interruptSession(runId).catch(() => false);
          // The run is dead: drop its routing entry so the map cannot grow
          // forever. (A late done event would also remove it.)
          runRouting.delete(runId);
        }
      }
      // Settle locally: chunks already received stay on screen as ordinary
      // rows even if the backend's done event never arrives (kill missed).
      const pending = drainPending(key);
      set((s) => {
        const cur = s.bySession[key] ?? EMPTY_SESSION;
        const messages = settleLiveRows(
          pending
            ? applyStreamParts(cur.messages, pending.parts, pending.model)
            : cur.messages,
        );
        return {
          bySession: {
            ...s.bySession,
            [key]: { ...cur, messages, streaming: false, interrupted: true, turnStartedAt: null },
          },
          streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
        };
      });
    },

    deleteSession: async (engine, sessionId) => {
      try {
        await ipc.deleteSession(engine, sessionId);
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set({ actionError: null });
      const tab = get().openTabs.find((t) => t.engine === engine && t.sessionId === sessionId);
      set((s) => ({
        sessions: s.sessions.filter(
          (x) => !(x.engine === engine && x.sessionId === sessionId),
        ),
      }));
      if (tab) {
        // removeTab activates the neighboring tab when the deleted one was active.
        removeTab(engine, sessionId, tab.workspacePath);
      } else {
        set((s) => ({
          active:
            s.active?.sessionId === sessionId && s.active.engine === engine ? null : s.active,
        }));
      }
    },

    pinSession: async (engine, sessionId, pinned) => {
      try {
        await ipc.pinSession(engine, sessionId, pinned);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    renameSession: async (engine, sessionId, title) => {
      try {
        await ipc.renameSession(engine, sessionId, title);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },
  };
});

// Dev-only handle for poking the store from the webview console; stripped
// from production builds by the env guard.
if (import.meta.env.DEV) {
  (window as unknown as { __chatStore: typeof useChatStore }).__chatStore = useChatStore;
}

// HMR swaps this module for a fresh store; without dispose the old module's
// engine/session listeners keep firing into the dead store (and init on the
// new store would double-subscribe).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const teardown of eventTeardowns.splice(0)) teardown();
  });
}
