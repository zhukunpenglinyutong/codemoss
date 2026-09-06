/**
 * File-path detection and file-link URLs for chat markdown.
 * Compact port of desktop-cc-gui's utils/remarkFileLinks.ts — inline code
 * spans and link targets that look like file paths render as green
 * dotted-underline links that open the file.
 *
 * Scheme is app-internal: `ccgui-file:<encodeURIComponent(path)>`.
 */

const FILE_LINK_PROTOCOL = "ccgui-file:";

const SPACED_POSIX_FILE_PATH_PATTERN = String.raw`\/(?:Users|Volumes|home|tmp|var|private)\/[^\r\n\`"'<>]*?\.[A-Za-z0-9]{1,12}(?:#[A-Za-z0-9:_-]+)?`;
const WINDOWS_ABSOLUTE_PATH_PATTERN = String.raw`[A-Za-z]:[\\/](?![\\/])[^\s\`"'<>\|]+`;
const FILE_PATH_PATTERN = new RegExp(
  String.raw`(${SPACED_POSIX_FILE_PATH_PATTERN}|${WINDOWS_ABSOLUTE_PATH_PATTERN}|\/[^\s\`"'<>]+|~\/[^\s\`"'<>]+|\.{1,2}\/[^\s\`"'<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)`,
);
const FILE_PATH_MATCH = new RegExp(`^${FILE_PATH_PATTERN.source}$`);
const WINDOWS_ABSOLUTE_PATH_MATCH = new RegExp(`^${WINDOWS_ABSOLUTE_PATH_PATTERN}$`);

const TRAILING_PUNCTUATION = { ".": true, ",": true, ";": true, ":": true, "!": true, "?": true, ")": true, "]": true, "}": true } as Record<string, true>;
// CJK ideographs/kana/full-width punctuation: prose characters that never
// appear in real file paths — a slash-joined CJK token is prose, not a path,
// unless its last segment carries a file extension.
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿＀-￯]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/;
const RELATIVE_ALLOWED_PREFIXES = [
  "src/",
  "src-tauri/",
  "app/",
  "lib/",
  "tests/",
  "test/",
  "packages/",
  "apps/",
  "docs/",
  "scripts/",
];

function isPathCandidate(value: string) {
  if (WINDOWS_ABSOLUTE_PATH_MATCH.test(value)) return true;
  if (!value.includes("/")) return false;
  if (value.startsWith("//")) return false;
  if (CJK_PATTERN.test(value) && !FILE_EXTENSION_PATTERN.test(value.split("/").pop() ?? "")) {
    return false;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  ) {
    // Slash-commands like /commit or /aimax:plan: single segment without a
    // file extension is a chat command, not a path.
    if (value.startsWith("/") && !value.slice(1).includes("/")) {
      const segment = value.slice(1);
      if (segment.includes(":") || !segment.includes(".")) return false;
    }
    return true;
  }
  const lastSegment = value.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return true;
  return RELATIVE_ALLOWED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function splitTrailingPunctuation(value: string) {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION[value[end - 1] ?? ""]) end -= 1;
  return { path: value.slice(0, end), trailing: value.slice(end) };
}

/** True when an inline-code / link-target string is a plausible file path. */
export function isLinkableFilePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !FILE_PATH_MATCH.test(trimmed)) return false;
  return isPathCandidate(trimmed);
}

export function toFileLink(path: string) {
  return `${FILE_LINK_PROTOCOL}${encodeURIComponent(path)}`;
}

export function isFileLinkUrl(url: string) {
  return url.startsWith(FILE_LINK_PROTOCOL);
}

export function decodeFileLink(url: string) {
  const raw = url.slice(FILE_LINK_PROTOCOL.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve a markdown-sourced path to an absolute one. Relative paths anchor
 * at the session's workspace; absolute POSIX/Windows paths pass through.
 * Returns null for `~/` paths (home dir unknown to the frontend) and empties.
 */
export function resolveFilePath(path: string, workspacePath: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("~/")) return null;
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_PATH_MATCH.test(trimmed)) return trimmed;
  const relative = trimmed.replace(/^\.\//, "");
  if (trimmed.startsWith("../")) return null; // escaping the workspace: don't guess
  const root = workspacePath.replace(/[/\\]+$/, "");
  return root ? `${root}/${relative}` : null;
}
