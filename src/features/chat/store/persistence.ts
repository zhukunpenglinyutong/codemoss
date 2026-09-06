import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * Tab/active-session persistence (localStorage) plus the session-key helpers
 * every chat module shares. Leaf module: no store imports, so stream and
 * engine-events can both build on it without cycles.
 */

export interface ActiveSession {
  engine: string;
  /** null => not yet created (first message not sent) */
  sessionId: string | null;
  workspacePath: string;
}

export function sessionKey(engine: string, sessionId: string | null, workspacePath: string) {
  return sessionId ? `${engine}/${sessionId}` : `new:${engine}:${workspacePath}`;
}

const OPEN_TABS_KEY = "ccgui-next.openTabs:v1";
const ACTIVE_SESSION_KEY = "ccgui-next.activeSession:v1";
const LEGACY_OPEN_TABS_KEY = "ccgui-next.openTabs";
const LEGACY_ACTIVE_SESSION_KEY = "ccgui-next.activeSession";
export const ENGINE_PREF_KEY = "ccgui-next.enginePref";

export function sameTab(
  tab: ActiveSession,
  engine: string,
  sessionId: string | null,
  workspacePath: string,
) {
  return tab.engine === engine && tab.sessionId === sessionId && tab.workspacePath === workspacePath;
}

export function persistTabs(openTabs: ActiveSession[], active: ActiveSession | null) {
  writeStored(OPEN_TABS_KEY, JSON.stringify(openTabs));
  if (active) writeStored(ACTIVE_SESSION_KEY, JSON.stringify(active));
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
}

/** Read a persisted JSON value, migrating the pre-versioned key on first read. */
function readPersistedValue<T>(
  key: string,
  legacyKey: string,
  validate: (value: unknown) => T | null,
): T | null {
  const current = readStoredJson(key, validate);
  if (current !== null) return current;
  const legacy = readStoredJson(legacyKey, validate);
  if (legacy === null) return null;
  // One-time migration: the validated legacy value moves to the versioned key.
  writeStored(key, JSON.stringify(legacy));
  localStorage.removeItem(legacyKey);
  return legacy;
}

function isActiveSession(t: unknown): t is ActiveSession {
  return (
    !!t &&
    typeof (t as ActiveSession).engine === "string" &&
    typeof (t as ActiveSession).workspacePath === "string" &&
    ((t as ActiveSession).sessionId === null || typeof (t as ActiveSession).sessionId === "string")
  );
}

export function readPersistedTabs(): ActiveSession[] {
  return (
    readPersistedValue(OPEN_TABS_KEY, LEGACY_OPEN_TABS_KEY, (raw) =>
      Array.isArray(raw) ? raw.filter(isActiveSession) : null,
    ) ?? []
  );
}

export function readPersistedActive(): ActiveSession | null {
  return readPersistedValue(ACTIVE_SESSION_KEY, LEGACY_ACTIVE_SESSION_KEY, (raw) =>
    raw &&
    typeof (raw as ActiveSession).engine === "string" &&
    typeof (raw as ActiveSession).workspacePath === "string"
      ? (raw as ActiveSession)
      : null,
  );
}
