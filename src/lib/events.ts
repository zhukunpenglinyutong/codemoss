import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface EngineEventPayload {
  runId: string;
  sessionId: string | null;
  engine: string;
  seq: number;
  kind: "delta" | "thinking" | "message" | "session" | "usage" | "error" | "done";
  data: unknown;
}

/** Batched engine events arrive as an array under a single event name. */
export function listenEngineEvents(
  cb: (events: EngineEventPayload[]) => void,
): Promise<UnlistenFn> {
  return listen<EngineEventPayload[]>("engine://event", (e) => cb(e.payload));
}

export function listenSessionsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("sessions://changed", () => cb());
}
export interface ScanProgress {
  done: number;
  total: number;
  /** True on the last event of a scan run. */
  finished: boolean;
}

/** History-scan progress, throttled by the scanner (~50 updates per run). */
export function listenScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (e) => cb(e.payload));
}
export interface TerminalOutputPayload {
  id: string;
  data: string;
}

/** Batched PTY output: arrays of chunks flushed at 32ms / 64KB by the sink. */
export function listenTerminalOutput(
  cb: (chunks: TerminalOutputPayload[]) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputPayload[]>("terminal://output", (e) => cb(e.payload));
}
