import type { Message } from "@/lib/ipc";

/**
 * Streaming buffers and bySession write helpers. Leaf module: functions are
 * generic over a minimal BySessionSlice so neither this file nor
 * engine-events needs a runtime import of the store itself (no cycles).
 */

export interface QueuedMessage {
  id: string;
  text: string;
  images: string[];
  queuedAt: number;
}

export interface SessionState {
  messages: Message[];
  nextBefore: number | null;
  loading: boolean;
  streaming: boolean;
  /** Epoch ms when the current streaming turn began; drives the tail
   * indicator's elapsed timer so it survives the indicator's unmount/remount
   * cycle (idle ↔ growing) instead of restarting from 0 every pause. */
  turnStartedAt: number | null;
  usage: unknown;
  error: string | null;
  /** Messages typed while a turn streams; sent FIFO when the turn ends. */
  queue: QueuedMessage[];
  /** Set by interrupt(): the next "done" settles the turn but must not
   * auto-drain the queue — pressing stop is not "go on to the next". */
  interrupted: boolean;
}

export const EMPTY_SESSION: SessionState = {
  messages: [],
  nextBefore: null,
  loading: false,
  streaming: false,
  turnStartedAt: null,
  usage: null,
  error: null,
  queue: [],
  interrupted: false,
};

/** Minimal store shape these helpers touch. */
export interface BySessionSlice {
  bySession: Record<string, SessionState>;
}

export type SetFn<T extends BySessionSlice> = (fn: (s: T) => Partial<T>) => void;

/** runId -> sessionKey routing for engine events. Entries are removed when
 * the run settles (done/error) or is interrupted — the map must not grow
 * monotonically over the app's lifetime. */
export const runRouting = new Map<string, string>();

/** One ordered stream chunk. Thinking and text deltas interleave within a
 * turn (extended thinking resumes between tool calls), so per-kind string
 * buffers would scramble their relative order; parts append in arrival order
 * and merge with the previous part when the kind matches. */
interface StreamPart {
  kind: "delta" | "thinking";
  text: string;
}
interface PendingStream {
  model: string | null;
  parts: StreamPart[];
}
/** sessionKey -> ordered stream chunks not yet flushed into rows */
const pendingStreams = new Map<string, PendingStream>();
let rafScheduled = false;
let fallbackScheduled = false;

/** Fold stream parts into the message list in place: a part grows the last
 * row when it is the same role and still live, otherwise it starts a new
 * live row. The streaming message therefore *is* the final message — no
 * buffer→commit transition for content to hide behind, no replay of text
 * the user already watched arrive. Row order stays chronological, matching
 * what history parsing produces. */
export function applyStreamParts(
  messages: Message[],
  parts: StreamPart[],
  model: string | null,
): Message[] {
  let out = messages;
  for (const part of parts) {
    if (!part.text) continue;
    const role = part.kind === "thinking" ? "thinking" : "assistant";
    const last = out[out.length - 1];
    if (last?.live && last.role === role) {
      out = [...out.slice(0, -1), { ...last, text: last.text + part.text }];
      continue;
    }
    const seq = out.length ? out[out.length - 1].seq + 1 : 1;
    out = [
      ...out,
      {
        seq,
        role,
        text: part.text,
        ts: new Date().toISOString(),
        live: true,
        ...(role === "assistant" ? { model } : {}),
      },
    ];
  }
  return out;
}

/** Clear the live flag on every row; identity-preserving when nothing is
 * live. Rows stop growing once their segment is over (tool start, turn end). */
export function settleLiveRows(messages: Message[]): Message[] {
  if (!messages.some((m) => m.live)) return messages;
  return messages.map((m) => (m.live ? { ...m, live: false } : m));
}

export function bufferStreamPart(
  key: string,
  kind: StreamPart["kind"],
  text: string,
  model: string | null,
) {
  const pending = pendingStreams.get(key) ?? { model, parts: [] };
  const last = pending.parts[pending.parts.length - 1];
  if (last?.kind === kind) last.text += text;
  else pending.parts.push({ kind, text });
  pendingStreams.set(key, pending);
}

/** Pull one session's unflushed stream chunks out of the pending map. Any
 * structural path (tool row, done, error, interrupt) must fold these in —
 * otherwise chunks between the last flush and the structural event land
 * after it, out of order. */
export function drainPending(key: string): PendingStream | null {
  const pending = pendingStreams.get(key) ?? null;
  pendingStreams.delete(key);
  return pending;
}

/** Move unflushed stream chunks when a session's key changes (pending tab
 * adopts its native id), or the next flush resurrects the old key with
 * orphaned content. */
export function migratePendingStream(fromKey: string, toKey: string) {
  const pending = pendingStreams.get(fromKey);
  if (!pending) return;
  pendingStreams.delete(fromKey);
  const existing = pendingStreams.get(toKey);
  pendingStreams.set(
    toKey,
    existing
      ? { model: existing.model ?? pending.model, parts: [...existing.parts, ...pending.parts] }
      : pending,
  );
}

/** Append a live tool-call row. Buffered stream chunks are folded in first
 * so an interleaved "thinking → text → tool → text" turn keeps chronological
 * order, and the rows they grew settle — the next delta starts a fresh row
 * below the tool call. */
export function appendToolMessage<T extends BySessionSlice>(
  set: SetFn<T>,
  key: string,
  text: string,
  model: string | null,
) {
  const pending = drainPending(key);
  set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    let messages = pending
      ? applyStreamParts(prev.messages, pending.parts, pending.model ?? model)
      : prev.messages;
    messages = settleLiveRows(messages);
    const seq = messages.length ? messages[messages.length - 1].seq + 1 : 1;
    messages = [...messages, { role: "tool", text, ts: new Date().toISOString(), seq }];
    return { bySession: { ...s.bySession, [key]: { ...prev, messages } } } as Partial<T>;
  });
}

export function patchSession<T extends BySessionSlice>(
  set: SetFn<T>,
  key: string,
  patch: Partial<SessionState>,
) {
  set((s) => ({
    bySession: {
      ...s.bySession,
      [key]: { ...(s.bySession[key] ?? EMPTY_SESSION), ...patch },
    },
  }) as Partial<T>);
}

export function flushPendingStreams<T extends BySessionSlice>(set: SetFn<T>) {
  if (pendingStreams.size === 0) return;
  set((s) => {
    const bySession = { ...s.bySession };
    for (const [key, pending] of pendingStreams) {
      const prev = bySession[key] ?? EMPTY_SESSION;
      bySession[key] = {
        ...prev,
        messages: applyStreamParts(prev.messages, pending.parts, pending.model),
      };
    }
    return { bySession } as Partial<T>;
  });
  pendingStreams.clear();
}

export function scheduleDeltaFlush<T extends BySessionSlice>(set: SetFn<T>) {
  // rAF stalls while the webview is occluded or the tab is backgrounded;
  // the timer guarantees buffered deltas still land within ~100ms. The
  // structural paths (tool row / done / error) drain the map directly, so a
  // late fallback flush is a harmless no-op.
  if (!fallbackScheduled) {
    fallbackScheduled = true;
    setTimeout(() => {
      fallbackScheduled = false;
      flushPendingStreams(set);
    }, 100);
  }
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    flushPendingStreams(set);
  });
}

/** Write one session's streaming flag into the flat map ChatPage subscribes.
 * Reference-stable when the flag does not actually flip, so selectors keyed
 * on the map only re-render on real start/stop transitions. */
export function setStreamingFlag(
  rec: Record<string, true>,
  key: string,
  on: boolean,
): Record<string, true> {
  const has = rec[key] === true;
  if (has === on) return rec;
  const next = { ...rec };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

/** Carry the streaming flag across a session-key migration. */
export function moveStreamingFlag(
  rec: Record<string, true>,
  fromKey: string,
  toKey: string,
): Record<string, true> {
  if (rec[fromKey] !== true || fromKey === toKey) return rec;
  const next = { ...rec };
  delete next[fromKey];
  next[toKey] = true;
  return next;
}
