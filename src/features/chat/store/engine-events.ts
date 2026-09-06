import { ipc, type SessionMeta } from "@/lib/ipc";
import type { EngineEventPayload } from "@/lib/events";
import { persistTabs, sessionKey } from "./persistence";
import {
  EMPTY_SESSION,
  appendToolMessage,
  applyStreamParts,
  bufferStreamPart,
  drainPending,
  migratePendingStream,
  moveStreamingFlag,
  patchSession,
  runRouting,
  scheduleDeltaFlush,
  setStreamingFlag,
  settleLiveRows,
} from "./stream";
import type { ChatStore } from "../store";

/**
 * Engine-event handling: the main loop resolves each event's session key and
 * dispatches to one handler per event kind. Store-agnostic apart from the
 * ChatStore type (type-only import, so no runtime cycle with store.ts);
 * everything the handlers need arrives through EngineEventDeps.
 */

export interface EngineEventDeps {
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void;
  get: () => ChatStore;
  /** After a turn ends, send the oldest queued message for that session. */
  drainQueue: (key: string) => void;
  /** Flag a finished background session for the sidebar's unseen dot. */
  markUnseenIfBackground: (key: string) => void;
  /** Insert/bump a freshly created session in the sidebar list cache. */
  upsertSessionMeta: (meta: SessionMeta) => void;
}

/** Collapse whitespace and cap a prompt for use as a session title. */
export function firstLineTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** List-cache entry for a session the backend scanner has not seen yet. */
export function optimisticMeta(
  engine: string,
  sessionId: string,
  workspacePath: string,
  title: string,
): SessionMeta {
  const now = Date.now();
  return {
    engine,
    sessionId,
    workspacePath,
    filePath: "",
    fileSize: 0,
    fileMtimeMs: 0,
    title,
    preview: "",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    pinned: false,
    customTitle: null,
  };
}

/** Insert a freshly created session into the sidebar list cache (or bump its
 * timestamp when already present). Without this the row and the tab title
 * stayed missing/"新对话" until the post-turn rescan completed. */
export function upsertSessionMetaInto(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  meta: SessionMeta,
) {
  set((s) => {
    const idx = s.sessions.findIndex(
      (x) => x.engine === meta.engine && x.sessionId === meta.sessionId,
    );
    if (idx < 0) return { sessions: [meta, ...s.sessions] };
    const sessions = s.sessions.slice();
    sessions[idx] = { ...sessions[idx], updatedAt: meta.updatedAt };
    return { sessions };
  });
}

function onDelta(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  bufferStreamPart(key, "delta", event.data as string, deps.get().models[event.engine] || null);
  scheduleDeltaFlush(deps.set);
}

function onThinking(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  bufferStreamPart(key, "thinking", event.data as string, deps.get().models[event.engine] || null);
  scheduleDeltaFlush(deps.set);
}

function onMessage(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  const data = event.data as { role: string; text: string };
  if (data.role === "tool") {
    appendToolMessage(deps.set, key, data.text, deps.get().models[event.engine] || null);
    return;
  }
  if (data.role !== "assistant") return;
  // Full-snapshot assistant lines (kimi/codex non-delta) append as settled
  // messages; any live row above is finished growing.
  deps.set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const settled = settleLiveRows(prev.messages);
    const seq = settled.length ? settled[settled.length - 1].seq + 1 : 1;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          messages: [
            ...settled,
            {
              role: "assistant",
              text: data.text,
              ts: new Date().toISOString(),
              model: deps.get().models[event.engine] || null,
              seq,
            },
          ],
        },
      },
    };
  });
}

function onSession(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  const nativeId = event.data as string;
  // Resolve the workspace from the tab that owns this key — not from the
  // active tab. A first message sent on a background tab must not adopt the
  // foreground tab's workspace (the session would be orphaned there).
  const tab = deps
    .get()
    .openTabs.find((t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key);
  const workspacePath = tab?.workspacePath ?? deps.get().active?.workspacePath ?? "";
  const newKey = sessionKey(event.engine, nativeId, workspacePath);
  runRouting.set(event.runId, newKey);
  // Unflushed stream chunks sit under the pre-migration key; move them too.
  migratePendingStream(key, newKey);
  // Migrate pending key -> native key.
  deps.set((s) => {
    const prev = s.bySession[key];
    if (!prev) return {};
    const bySession = { ...s.bySession, [newKey]: prev };
    if (key !== newKey) delete bySession[key];
    const drafts = { ...s.drafts };
    if (key in drafts) {
      drafts[newKey] = drafts[key];
      delete drafts[key];
    }
    const streamingByKey = moveStreamingFlag(s.streamingByKey, key, newKey);
    const activeNext =
      s.active && s.active.engine === event.engine && s.active.sessionId === null
        ? { ...s.active, sessionId: nativeId }
        : s.active;
    return { bySession, drafts, streamingByKey, active: activeNext };
  });
  // The pending tab adopts the native id too. Match by the resolved
  // workspace, so a background tab updates itself, not the foreground tab.
  deps.set((s) => {
    const openTabs = s.openTabs.map((t) =>
      t.engine === event.engine && t.sessionId === null && t.workspacePath === workspacePath
        ? { ...t, sessionId: nativeId }
        : t,
    );
    persistTabs(openTabs, s.active);
    return { openTabs };
  });
  // Sidebar row + tab title pick the new session up immediately instead of
  // waiting for the post-turn rescan.
  const firstUser = (deps.get().bySession[newKey]?.messages ?? []).find(
    (m) => m.role === "user",
  );
  deps.upsertSessionMeta(
    optimisticMeta(
      event.engine,
      nativeId,
      workspacePath,
      firstUser ? firstLineTitle(firstUser.text) : "",
    ),
  );
}

function onUsage(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  patchSession(deps.set, key, { usage: event.data });
}

function onError(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  // Fold unflushed chunks into rows and settle them: the turn stops here,
  // and the scheduled flush must not write them in after the fact.
  const pending = drainPending(key);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    const messages = settleLiveRows(
      pending
        ? applyStreamParts(cur.messages, pending.parts, pending.model ?? (deps.get().models[event.engine] || null))
        : cur.messages,
    );
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          error: event.data as string,
          streaming: false,
          turnStartedAt: null,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  deps.markUnseenIfBackground(key);
}

function onDone(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  const prev = deps.get().bySession[key] ?? EMPTY_SESSION;
  const data = event.data as { usage: unknown };
  const finalUsage = data.usage ?? prev.usage;
  // Fold the turn's last unflushed chunks (the final sink batch can arrive
  // in the same frame as done), then settle every live row: the streamed
  // text the user watched arrive *is* the final message.
  const pending = drainPending(key);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    let messages = pending
      ? applyStreamParts(cur.messages, pending.parts, pending.model ?? (deps.get().models[event.engine] || null))
      : cur.messages;
    messages = settleLiveRows(messages);
    // Stamp usage onto the turn's last assistant message, mirroring how
    // history parsing attaches __usage__ rows; without this the footer shows
    // tokens only after a reload.
    if (finalUsage) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          messages = [
            ...messages.slice(0, i),
            { ...messages[i], usage: finalUsage },
            ...messages.slice(i + 1),
          ];
          break;
        }
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          streaming: false,
          turnStartedAt: null,
          usage: finalUsage,
          interrupted: false,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  // Native file changed; refresh list cache in background.
  ipc.rescanSessions().catch(() => {});
  deps.markUnseenIfBackground(key);
  // An interrupted turn settles here too: keep the queue parked — the user
  // stopped the session, the next message is theirs to send.
  if (!prev.interrupted) deps.drainQueue(key);
}

/** Resolve an event's session key (run routing, then session-id match) and
 * dispatch to the per-kind handler. */
export function handleEngineEvents(events: EngineEventPayload[], deps: EngineEventDeps) {
  for (const event of events) {
    const state = deps.get();
    let key = runRouting.get(event.runId);
    if (!key && event.sessionId) {
      key = sessionKey(event.engine, event.sessionId, "");
      // sessionId-only key lacks workspace; find active match
      if (!(key in state.bySession)) {
        const match = Object.keys(state.bySession).find(
          (k) => k === key || k.endsWith(`/${event.sessionId}`),
        );
        if (match) key = match;
      }
    }
    if (!key) continue;

    switch (event.kind) {
      case "delta":
        onDelta(event, key, deps);
        break;
      case "thinking":
        onThinking(event, key, deps);
        break;
      case "message":
        onMessage(event, key, deps);
        break;
      case "session":
        onSession(event, key, deps);
        break;
      case "usage":
        onUsage(event, key, deps);
        break;
      case "error":
        onError(event, key, deps);
        break;
      case "done":
        onDone(event, key, deps);
        break;
    }
  }
}
