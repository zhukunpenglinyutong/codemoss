import { ipc } from "@/lib/ipc";
import { readStoredJson, writeStored } from "@/lib/storage";
import vscodeIcon from "@/assets/app-icons/vscode.png?url";
import cursorIcon from "@/assets/app-icons/cursor.png?url";
import ideaIcon from "@/assets/app-icons/idea.png?url";
import finderIcon from "@/assets/app-icons/finder.png?url";

/**
 * Curated "open with" targets for the header. Migrated from the legacy app's
 * preset catalog, trimmed to the four targets that made the cut: VS Code,
 * Cursor, IntelliJ IDEA and the OS file manager.
 */
export type OpenAppTarget = {
  id: string;
  label: string;
  kind: "app" | "finder";
  /** macOS `open -a` name; other platforms resolve a matching CLI binary. */
  appName: string | null;
};

export const OPEN_APP_TARGETS: readonly OpenAppTarget[] = [
  { id: "vscode", label: "VS Code", kind: "app", appName: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", kind: "app", appName: "Cursor" },
  { id: "finder", label: "Finder", kind: "finder", appName: null },
  { id: "idea", label: "IntelliJ IDEA", kind: "app", appName: "IntelliJ IDEA" },
];

export const DEFAULT_OPEN_APP_ID = "vscode";

export const OPEN_APP_ICONS: Record<string, string> = {
  vscode: vscodeIcon,
  cursor: cursorIcon,
  idea: ideaIcon,
  finder: finderIcon,
};

/**
 * Which path a target receives: the file manager always gets the workspace
 * folder; editors prefer the file currently open in the files panel.
 */
export function resolveOpenAppPath(
  target: Pick<OpenAppTarget, "kind">,
  options: { workspacePath: string; activeFilePath?: string | null },
): string {
  if (target.kind === "finder") return options.workspacePath;
  return options.activeFilePath?.trim() || options.workspacePath;
}

export async function openPathInTarget(path: string, target: OpenAppTarget): Promise<void> {
  if (target.kind === "finder") {
    await ipc.revealInFileManager(path);
    return;
  }
  if (!target.appName) return;
  await ipc.openWorkspaceIn(path, { appName: target.appName });
}

// ---------- header pinning / selection persistence (localStorage) ----------

const PINNED_IDS_KEY = "ccgui-next.headerPinnedActions";
const SELECTED_APP_KEY = "ccgui-next.openWorkspaceApp";

/** "terminal" is a pinnable extra action, not an open target. */
export const TERMINAL_ACTION_ID = "terminal";

export const DEFAULT_PINNED_IDS: readonly string[] = [DEFAULT_OPEN_APP_ID, TERMINAL_ACTION_ID];

export function readPinnedIds(): string[] {
  return (
    readStoredJson<string[]>(PINNED_IDS_KEY, (stored) =>
      Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : null,
    ) ?? [...DEFAULT_PINNED_IDS]
  );
}

export function writePinnedIds(ids: string[]): void {
  writeStored(PINNED_IDS_KEY, JSON.stringify(ids));
}

export function readSelectedOpenAppId(): string {
  const stored = localStorage.getItem(SELECTED_APP_KEY);
  return stored && OPEN_APP_TARGETS.some((target) => target.id === stored)
    ? stored
    : DEFAULT_OPEN_APP_ID;
}

export function writeSelectedOpenAppId(id: string): void {
  writeStored(SELECTED_APP_KEY, id);
}
