/**
 * localStorage helpers with validation. Reads fall back on missing/corrupt
 * values; writes swallow storage-unavailable/full errors (non-fatal: the
 * value simply stays in memory, matching the persistTabs convention).
 */

/** Numeric preference; `fallback` when the stored value is missing or NaN. */
export function readStoredNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Boolean preference stored as "1"/"0" (or "true"/"false"). */
export function readStoredBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "1" || raw === "true";
}

/**
 * JSON preference; `validate` narrows the parsed payload or rejects it by
 * returning null. Missing, unparsable, or rejected values all yield null so
 * the caller can apply its own default.
 */
export function readStoredJson<T>(key: string, validate: (value: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable/full is non-fatal.
  }
}
