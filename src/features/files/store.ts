import { create } from "zustand";
import { ipc, type DirEntry, type FileContent } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";

export const FILES_ROOT_KEY = "ccgui-next.filesRoot";

/** Join a directory path and a child name. Backend paths are POSIX-style on
 * macOS/Linux; Rust's fs APIs also accept "/" separators on Windows. */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + "/" + name;
}

export function parentPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

export function fileName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export interface OpenFileState {
  path: string;
  /** null while the first read is in flight. */
  content: FileContent | null;
  loading: boolean;
  error: string | null;
  /** Bumped on every successful (re)load so the editor resets its draft. */
  loadNonce: number;
}

interface FilesStore {
  /** Folder the tree is rooted at; "" = unset. Persisted to localStorage. */
  root: string;
  /** dirPath -> loaded children (dirs first; backend sorts). Missing = not fetched. */
  children: Record<string, DirEntry[]>;
  loadingDirs: Record<string, true>;
  dirErrors: Record<string, string>;
  expanded: Record<string, true>;
  /** Currently selected tree node (file or dir). */
  selectedPath: string | null;
  /** Whether the selected tree node is a directory. */
  selectedIsDir: boolean;
  /** Open file tabs, in tab order. */
  openFiles: string[];
  /** Per-tab load state keyed by absolute path. */
  fileStates: Record<string, OpenFileState>;
  /** File tab shown in the center area; null = a chat tab is active. */
  activeFilePath: string | null;
  /** Paths with unsaved editor drafts (reported by EditorPane). */
  dirtyPaths: Record<string, true>;

  setRoot: (path: string) => void;
  ensureDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  /** Re-fetch a directory only if it has been loaded before. */
  invalidateDir: (path: string) => Promise<void>;
  selectPath: (path: string | null, isDir?: boolean) => void;
  /** Open a file as a center tab (or focus its existing tab). */
  openFile: (path: string) => Promise<void>;
  /** Switch the center area to an already-open file tab. */
  activateFile: (path: string) => void;
  /** Return the center area to the chat (a chat tab was selected). */
  clearActiveFile: () => void;
  /** Re-read a file from disk, resetting its editor draft. */
  reloadFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  /** Re-point open tabs after a rename/move (content unchanged on disk). */
  remapOpenFiles: (from: string, to: string) => void;
  /** Close every tab at or under a removed path. */
  closeFilesUnder: (path: string) => void;
  setFileDirty: (path: string, dirty: boolean) => void;
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  root: localStorage.getItem(FILES_ROOT_KEY) ?? "",
  children: {},
  loadingDirs: {},
  dirErrors: {},
  expanded: {},
  selectedPath: null,
  selectedIsDir: false,
  openFiles: [],
  fileStates: {},
  activeFilePath: null,
  dirtyPaths: {},

  setRoot: (path) => {
    const root = path.trim();
    if (root === get().root) return;
    if (root) {
      writeStored(FILES_ROOT_KEY, root);
    } else {
      localStorage.removeItem(FILES_ROOT_KEY);
    }
    // Open file tabs survive root (workspace) switches — they are absolute
    // paths and stay editable regardless of which tree is shown.
    set({
      root,
      children: {},
      loadingDirs: {},
      dirErrors: {},
      expanded: {},
      selectedPath: null,
      selectedIsDir: false,
    });
    if (root) void get().ensureDir(root);
  },

  ensureDir: async (path) => {
    const s = get();
    if (s.children[path] || s.loadingDirs[path]) return;
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [path]: true } }));
    try {
      const entries = await ipc.listDir(path);
      set((s) => {
        const loadingDirs = { ...s.loadingDirs };
        const dirErrors = { ...s.dirErrors };
        delete loadingDirs[path];
        delete dirErrors[path];
        return {
          children: { ...s.children, [path]: entries },
          loadingDirs,
          dirErrors,
        };
      });
    } catch (e) {
      set((s) => {
        const loadingDirs = { ...s.loadingDirs };
        delete loadingDirs[path];
        return {
          loadingDirs,
          dirErrors: { ...s.dirErrors, [path]: errorText(e) },
        };
      });
    }
  },

  toggleDir: async (path) => {
    const s = get();
    if (s.expanded[path]) {
      const expanded = { ...s.expanded };
      delete expanded[path];
      set({ expanded });
      return;
    }
    set((s) => ({ expanded: { ...s.expanded, [path]: true } }));
    await get().ensureDir(path);
  },

  invalidateDir: async (path) => {
    if (!get().children[path]) return;
    try {
      const entries = await ipc.listDir(path);
      set((s) => ({ children: { ...s.children, [path]: entries } }));
    } catch {
      // Keep stale listing on refresh failure; the user can retry by toggling.
    }
  },

  selectPath: (path, isDir = false) => set({ selectedPath: path, selectedIsDir: isDir }),

  openFile: async (path) => {
    if (get().fileStates[path]) {
      set({ activeFilePath: path, selectedPath: path, selectedIsDir: false });
      return;
    }
    set((s) => ({
      openFiles: [...s.openFiles, path],
      fileStates: {
        ...s.fileStates,
        [path]: { path, content: null, loading: true, error: null, loadNonce: 0 },
      },
      activeFilePath: path,
      selectedPath: path,
      selectedIsDir: false,
    }));
    await get().reloadFile(path);
  },

  activateFile: (path) => {
    if (get().fileStates[path]) set({ activeFilePath: path });
  },

  clearActiveFile: () => set({ activeFilePath: null }),

  reloadFile: async (path) => {
    set((s) => {
      const st = s.fileStates[path];
      if (!st) return s;
      return {
        fileStates: { ...s.fileStates, [path]: { ...st, loading: true, error: null } },
      };
    });
    try {
      const content = await ipc.readFile(path);
      set((s) => {
        const st = s.fileStates[path];
        if (!st) return s; // tab closed mid-load
        return {
          fileStates: {
            ...s.fileStates,
            [path]: { ...st, content, loading: false, loadNonce: st.loadNonce + 1 },
          },
        };
      });
    } catch (e) {
      const message = errorText(e);
      set((s) => {
        const st = s.fileStates[path];
        if (!st) return s;
        return {
          fileStates: { ...s.fileStates, [path]: { ...st, loading: false, error: message } },
        };
      });
    }
  },

  closeFile: (path) =>
    set((s) => {
      if (!s.fileStates[path]) return s;
      const openFiles = s.openFiles.filter((p) => p !== path);
      const fileStates = { ...s.fileStates };
      delete fileStates[path];
      const dirtyPaths = { ...s.dirtyPaths };
      delete dirtyPaths[path];
      let activeFilePath = s.activeFilePath;
      if (activeFilePath === path) {
        const idx = s.openFiles.indexOf(path);
        // Focus the tab that slid into the closed one's slot (or the last).
        activeFilePath = openFiles[Math.min(idx, openFiles.length - 1)] ?? null;
      }
      return { openFiles, fileStates, dirtyPaths, activeFilePath };
    }),

  remapOpenFiles: (from, to) =>
    set((s) => {
      const mapPath = (p: string) =>
        p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p;
      if (!s.openFiles.some((p) => mapPath(p) !== p)) return s;
      const fileStates: Record<string, OpenFileState> = {};
      for (const [p, st] of Object.entries(s.fileStates)) {
        const np = mapPath(p);
        fileStates[np] = np === p ? st : { ...st, path: np };
      }
      const dirtyPaths: Record<string, true> = {};
      for (const p of Object.keys(s.dirtyPaths)) dirtyPaths[mapPath(p)] = true;
      return {
        openFiles: s.openFiles.map(mapPath),
        fileStates,
        dirtyPaths,
        activeFilePath: s.activeFilePath ? mapPath(s.activeFilePath) : null,
      };
    }),

  closeFilesUnder: (path) => {
    for (const p of [...get().openFiles]) {
      if (p === path || p.startsWith(path + "/")) get().closeFile(p);
    }
  },

  setFileDirty: (path, dirty) =>
    set((s) => {
      const has = !!s.dirtyPaths[path];
      if (dirty === has) return s;
      const dirtyPaths = { ...s.dirtyPaths };
      if (dirty) dirtyPaths[path] = true;
      else delete dirtyPaths[path];
      return { dirtyPaths };
    }),
}));
