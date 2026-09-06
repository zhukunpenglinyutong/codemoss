/**
 * Normalize an unknown thrown value to displayable text. Tauri command
 * errors arrive as plain strings or serialized objects, so Error.message
 * alone is not enough; unstringifiable values degrade to String().
 */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
