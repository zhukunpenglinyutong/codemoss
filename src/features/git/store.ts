import { create } from "zustand";
import { ipc, type BranchInfo, type GitStatus } from "@/lib/ipc";
import { errorText } from "@/lib/errors";

const TTL_MS = 30_000;

function isNotARepo(err: unknown): boolean {
  return errorText(err).includes("NOT_A_REPO");
}

/** Partial state marking a workspace as a non-repo after a NOT_A_REPO error. */
function notRepoPatch(workspacePath: string) {
  return (s: GitStore) => ({
    notRepoByWorkspace: { ...s.notRepoByWorkspace, [workspacePath]: true },
    statusByWorkspace: { ...s.statusByWorkspace, [workspacePath]: undefined },
  });
}

interface GitStore {
  statusByWorkspace: Record<string, GitStatus | undefined>;
  notRepoByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | null>;
  branchesByWorkspace: Record<string, BranchInfo[] | undefined>;
  /** epoch ms of last successful/failed fetch per workspace (TTL bookkeeping) */
  fetchedAtByWorkspace: Record<string, number>;

  /** Refreshes status; skipped when fetched < 30s ago unless `force`. */
  refresh: (workspacePath: string, force?: boolean) => Promise<void>;
  loadBranches: (workspacePath: string) => Promise<void>;

  // Mutating actions — each force-refreshes status afterwards. Errors are
  // re-thrown so callers can surface them inline.
  stage: (workspacePath: string, files: string[]) => Promise<void>;
  unstage: (workspacePath: string, files: string[]) => Promise<void>;
  commit: (workspacePath: string, message: string) => Promise<string>;
  push: (workspacePath: string) => Promise<void>;
  pull: (workspacePath: string) => Promise<void>;
  checkout: (workspacePath: string, branch: string) => Promise<void>;
  createBranch: (workspacePath: string, name: string) => Promise<void>;
}

/** In-flight refresh dedup per workspace. */
const inflight = new Map<string, Promise<void>>();

export const useGitStore = create<GitStore>((set, get) => {
  const runMutation = async (
    workspacePath: string,
    action: () => Promise<unknown>,
  ) => {
    try {
      return await action();
    } catch (err) {
      if (isNotARepo(err)) {
        set(notRepoPatch(workspacePath));
      }
      throw err;
    } finally {
      // Status changed (or may have): drop the TTL and refetch.
      set((s) => ({
        fetchedAtByWorkspace: { ...s.fetchedAtByWorkspace, [workspacePath]: 0 },
      }));
      get()
        .refresh(workspacePath, true)
        .catch(() => undefined);
    }
  };

  return {
    statusByWorkspace: {},
    notRepoByWorkspace: {},
    errorByWorkspace: {},
    branchesByWorkspace: {},
    fetchedAtByWorkspace: {},

    refresh: (workspacePath, force = false) => {
      const last = get().fetchedAtByWorkspace[workspacePath];
      if (!force && last && Date.now() - last < TTL_MS) return Promise.resolve();
      const pending = inflight.get(workspacePath);
      if (pending) return pending;

      const task = ipc
        .gitStatus(workspacePath)
        .then((status) => {
          set((s) => ({
            statusByWorkspace: { ...s.statusByWorkspace, [workspacePath]: status },
            notRepoByWorkspace: { ...s.notRepoByWorkspace, [workspacePath]: false },
            errorByWorkspace: { ...s.errorByWorkspace, [workspacePath]: null },
            fetchedAtByWorkspace: {
              ...s.fetchedAtByWorkspace,
              [workspacePath]: Date.now(),
            },
          }));
        })
        .catch((err: unknown) => {
          set((s) => ({
            statusByWorkspace: { ...s.statusByWorkspace, [workspacePath]: undefined },
            notRepoByWorkspace: {
              ...s.notRepoByWorkspace,
              [workspacePath]: isNotARepo(err),
            },
            errorByWorkspace: {
              ...s.errorByWorkspace,
              [workspacePath]: isNotARepo(err) ? null : errorText(err),
            },
            fetchedAtByWorkspace: {
              ...s.fetchedAtByWorkspace,
              [workspacePath]: Date.now(),
            },
          }));
        })
        .finally(() => {
          inflight.delete(workspacePath);
        });
      inflight.set(workspacePath, task);
      return task;
    },

    loadBranches: async (workspacePath) => {
      if (get().notRepoByWorkspace[workspacePath]) return;
      try {
        const branches = await ipc.gitBranches(workspacePath);
        set((s) => ({
          branchesByWorkspace: { ...s.branchesByWorkspace, [workspacePath]: branches },
        }));
      } catch (err) {
        if (isNotARepo(err)) {
          set(notRepoPatch(workspacePath));
        }
      }
    },

    stage: (workspacePath, files) =>
      runMutation(workspacePath, () => ipc.gitStage(workspacePath, files)) as Promise<void>,
    unstage: (workspacePath, files) =>
      runMutation(workspacePath, () => ipc.gitUnstage(workspacePath, files)) as Promise<void>,
    commit: (workspacePath, message) =>
      runMutation(workspacePath, () => ipc.gitCommit(workspacePath, message)) as Promise<string>,
    push: (workspacePath) =>
      runMutation(workspacePath, () => ipc.gitPush(workspacePath)) as Promise<void>,
    pull: (workspacePath) =>
      runMutation(workspacePath, () => ipc.gitPull(workspacePath)) as Promise<void>,
    checkout: async (workspacePath, branch) => {
      await runMutation(workspacePath, () => ipc.gitCheckout(workspacePath, branch));
      await get().loadBranches(workspacePath);
    },
    createBranch: async (workspacePath, name) => {
      await runMutation(workspacePath, () => ipc.gitCreateBranch(workspacePath, name));
      await get().loadBranches(workspacePath);
    },
  };
});
