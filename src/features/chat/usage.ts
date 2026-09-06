export interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Normalize the per-engine usage shapes (snake_case for claude/codex, bare
 * keys for pi/omp) into one token breakdown. Returns null when no tokens
 * were reported at all. */
export function parseUsage(usage: unknown): ParsedUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const input = num("input_tokens") || num("input");
  const output = num("output_tokens") || num("output");
  const cacheRead = num("cache_read_input_tokens") || num("cacheRead");
  const cacheWrite = num("cache_creation_input_tokens") || num("cacheWrite");
  const total =
    num("total_tokens") || num("totalTokens") || input + output + cacheRead + cacheWrite;
  if (!total) return null;
  return { input, output, cacheRead, cacheWrite, total };
}
