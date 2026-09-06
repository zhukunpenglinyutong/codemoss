import { invoke } from "@tauri-apps/api/core";

// ==================== Shared types (mirror Rust serde camelCase) ====================

export interface SessionMeta {
  engine: string;
  sessionId: string;
  workspacePath: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  pinned: boolean;
  customTitle: string | null;
}

export interface Message {
  seq: number;
  role: string; // "user" | "assistant" | "tool" | "thinking"
  text: string;
  ts: string | null;
  usage?: unknown;
  model?: string | null;
  /** True while the row belongs to the in-flight stream and may still grow. */
  live?: boolean;
  /** Image attachments: data URLs render directly, absolute paths load via readFile. */
  images?: string[];
}

export interface SessionPage {
  messages: Message[];
  nextBefore: number | null;
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number | null;
  sortOrder: number | null;
}

export interface EngineInfo {
  id: string;
  available: boolean;
  supportsImages: boolean;
}
/** One entry of an engine's model catalog (`--list-models` probe). */
export interface EngineModel {
  /** Selector passed to `--model` ("provider/model"). */
  id: string;
  /** Display name when the catalog carries one. */
  name?: string | null;
  provider: string;
  /** Context window tokens when the catalog reports one. */
  contextWindow?: number | null;
}

/** An engine's model catalog plus how much trust the list deserves. */
export interface EngineCatalog {
  models: EngineModel[];
  /**
   * True when `models` is exactly what the CLI's model flag resolves
   * (config/registry/binary-derived): a stored pick outside it cannot
   * run and should reset to the leading entry. False for relay-probed
   * lists (claude), which may be partial.
   */
  authoritative: boolean;
}

export interface SendResult {
  runId: string;
  sessionId: string | null;
}

export interface ProviderSection {
  providers: Record<string, unknown>;
  current: string | null;
}

export interface CliConfig {
  claude: ProviderSection;
  kimi: ProviderSection;
  grok: ProviderSection;
  codex: ProviderSection;
  pi: ProviderSection;
  omp: ProviderSection;
  dsh: ProviderSection;
}

export interface AppSettings {
  theme: string;
  language: string;
  claudeBin: string | null;
  kimiBin: string | null;
  grokBin: string | null;
  codexBin: string | null;
  piBin: string | null;
  ompBin: string | null;
  dshBin: string | null;
  defaultModels: Record<string, string>;
  defaultEfforts: Record<string, string>;
  /** Max sessions listed per workspace in the sidebar (default 5). */
  sidebarThreadLimit: number;
  /** Composer send gesture: "enter" (Enter sends) or "cmdEnter" (⌘/Ctrl+Enter sends). */
  composerSendShortcut: string;
  /** Terminal shell override; null/empty = auto-detect. */
  terminalShellPath: string | null;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  kind: "text" | "image" | "binary";
  text: string | null;
  dataUrl: string | null;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface GitFileEntry {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  branch: string;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}
export interface AppMetrics {
  /** Resident memory of the app process, bytes. */
  memoryBytes: number;
  /** CPU usage since the previous poll, percent of one core. */
  cpuPercent: number;
}

// ==================== Typed invoke wrappers ====================
// Shared in-flight/cached app-settings promise: startup, the settings page
// and the chat store all read the same settings, so fetch once.
let settingsPromise: Promise<AppSettings> | null = null;

export const ipc = {
  // config
  getCliConfig: () => invoke<CliConfig>("get_cli_config"),
  upsertProvider: (engine: string, id: string, json: unknown) =>
    invoke<void>("upsert_provider", { engine, id, json }),
  deleteProvider: (engine: string, id: string) =>
    invoke<void>("delete_provider", { engine, id }),
  setCurrentProvider: (engine: string, id: string) =>
    invoke<void>("set_current_provider", { engine, id }),
  reorderProviders: (engine: string, ids: string[]) =>
    invoke<void>("reorder_providers", { engine, ids }),
  // settings
  getAppSettings: () =>
    (settingsPromise ??= invoke<AppSettings>("get_app_settings").catch((e) => {
      // Allow retry after a failed fetch instead of caching the rejection.
      settingsPromise = null;
      throw e;
    })),
  updateAppSettings: async (settings: AppSettings) => {
    await invoke<void>("update_app_settings", { settings });
    // Keep the cache in sync with the authoritative value just persisted.
    settingsPromise = Promise.resolve(settings);
  },
  // engine
  sendMessage: (args: {
    engine: string;
    workspacePath: string;
    sessionId: string | null;
    prompt: string;
    imagePaths: string[] | null;
    model: string | null;
    effort: string | null;
  }) => invoke<SendResult>("send_message", args),
  interruptSession: (sessionId: string) =>
    invoke<boolean>("interrupt_session", { sessionId }),
  listEngines: () => invoke<EngineInfo[]>("list_engines"),
  /** Persist a clipboard image to app home; returns its absolute path so it
   * can flow through the same path-based image pipeline as picked files. */
  savePastedImage: (dataBase64: string, extension: string) =>
    invoke<string>("save_pasted_image", { dataBase64, extension }),
  /** Copy explicitly user-picked files into the app sandbox and return the
   * new paths (same order). Picked paths live outside the sandbox, so the
   * engines' path-based image pipeline cannot read them in place. */
  importAttachments: (paths: string[]) => invoke<string[]>("import_attachments", { paths }),
  listEngineModels: (engine: string) =>
    invoke<EngineCatalog>("list_engine_models", { engine }),
  // history
  listSessions: () => invoke<SessionMeta[]>("list_sessions"),
  loadSessionPage: (
    engine: string,
    sessionId: string,
    limit?: number,
    beforeSeq?: number | null,
  ) => invoke<SessionPage>("load_session_page", { engine, sessionId, limit, beforeSeq }),
  deleteSession: (engine: string, sessionId: string) =>
    invoke<void>("delete_session", { engine, sessionId }),
  pinSession: (engine: string, sessionId: string, pinned: boolean) =>
    invoke<void>("pin_session", { engine, sessionId, pinned }),
  renameSession: (engine: string, sessionId: string, title: string) =>
    invoke<void>("rename_session", { engine, sessionId, title }),
  rescanSessions: () => invoke<void>("rescan_sessions"),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  addWorkspace: (path: string) => invoke<Workspace>("add_workspace", { path }),
  reorderWorkspaces: (ids: string[]) => invoke<void>("reorder_workspaces", { ids }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  // terminal
  /** Idempotent: re-opening a live session id is a no-op on the backend. */
  terminalOpen: (args: { id: string; cwd: string; cols: number; rows: number }) =>
    invoke<void>("terminal_open", args),
  terminalWrite: (id: string, data: string) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  /** No-op when the session is already gone. */
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  // files
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string) =>
    invoke<void>("write_file", { path, content }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renameItem: (from: string, to: string) => invoke<void>("rename_item", { from, to }),
  trashItem: (path: string) => invoke<void>("trash_item", { path }),
  searchText: (path: string, query: string) =>
    invoke<SearchHit[]>("search_text", { path, query }),
  // git
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitDiff: (path: string, file: string, staged: boolean) =>
    invoke<string>("git_diff", { path, file, staged }),
  gitStage: (path: string, files: string[]) => invoke<void>("git_stage", { path, files }),
  gitUnstage: (path: string, files: string[]) =>
    invoke<void>("git_unstage", { path, files }),
  gitCommit: (path: string, message: string) =>
    invoke<string>("git_commit", { path, message }),
  gitPush: (path: string) => invoke<void>("git_push", { path }),
  gitPull: (path: string) => invoke<void>("git_pull", { path }),
  gitBranches: (path: string) => invoke<BranchInfo[]>("git_branches", { path }),
  gitCheckout: (path: string, branch: string) =>
    invoke<void>("git_checkout", { path, branch }),
  gitCreateBranch: (path: string, name: string) =>
    invoke<void>("git_create_branch", { path, name }),
  // open-app
  openWorkspaceIn: (path: string, options: { appName: string; args?: string[] }) =>
    invoke<void>("open_workspace_in", { path, app: options.appName, args: options.args ?? [] }),
  revealInFileManager: (path: string) =>
    invoke<void>("reveal_in_file_manager", { path }),
  // metrics
  appMetrics: () => invoke<AppMetrics>("app_metrics"),
};
