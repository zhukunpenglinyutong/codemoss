import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CloudDownload from "lucide-react/dist/esm/icons/cloud-download";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Minus from "lucide-react/dist/esm/icons/minus";
import CloudUpload from "lucide-react/dist/esm/icons/cloud-upload";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { type GitFileEntry, type GitStatus } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { cx } from "@/utils/cx";
import { DiffView, type DiffTarget } from "./DiffView";
import { useGitStore } from "./store";

export function ChangesPanel({
  workspacePath,
  className,
}: {
  workspacePath: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const status = useGitStore((s) => s.statusByWorkspace[workspacePath]);
  const notRepo = useGitStore((s) => s.notRepoByWorkspace[workspacePath]);
  const refreshError = useGitStore((s) => s.errorByWorkspace[workspacePath]);
  const branches = useGitStore((s) => s.branchesByWorkspace[workspacePath]);

  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [commitMsg, setCommitMsg] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  useEffect(() => {
    void useGitStore.getState().refresh(workspacePath);
    void useGitStore.getState().loadBranches(workspacePath);
  }, [workspacePath]);

  /** Runs a mutating action: tracks busy state, surfaces errors inline. */
  const run = useCallback((key: string, action: () => Promise<unknown>) => {
    setPending((p) => ({ ...p, [key]: true }));
    setActionError(null);
    void action()
      .catch((err: unknown) => setActionError(errorText(err)))
      .finally(() => {
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      });
  }, []);

  const stage = useCallback(
    (files: string[]) =>
      run("stage", () => useGitStore.getState().stage(workspacePath, files)),
    [run, workspacePath],
  );
  const unstage = useCallback(
    (files: string[]) =>
      run("unstage", () => useGitStore.getState().unstage(workspacePath, files)),
    [run, workspacePath],
  );
  const stageOne = useCallback((file: string) => stage([file]), [stage]);
  const unstageOne = useCallback((file: string) => unstage([file]), [unstage]);
  const openStagedDiff = useCallback(
    (file: string) => setDiffTarget({ file, staged: true }),
    [],
  );
  const openUnstagedDiff = useCallback(
    (file: string) => setDiffTarget({ file, staged: false }),
    [],
  );

  const header = (
    <div className="flex flex-col gap-2 border-b border-separator-border px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-body-medium text-text-primary">{t("git.changes")}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={RefreshCw}
            size="small"
            aria-label={t("common.refresh")}
            disabled={pending.refresh === true}
            onClick={() =>
              run("refresh", () => useGitStore.getState().refresh(workspacePath, true))
            }
          />
          <IconButton
            icon={CloudDownload}
            size="small"
            aria-label={t("git.pull")}
            disabled={notRepo || pending.pull === true}
            onClick={() => run("pull", () => useGitStore.getState().pull(workspacePath))}
          />
          <IconButton
            icon={CloudUpload}
            size="small"
            aria-label={t("git.push")}
            disabled={notRepo || pending.push === true}
            onClick={() => run("push", () => useGitStore.getState().push(workspacePath))}
          />
        </div>
      </div>
      {!notRepo && (
        <div className="flex items-center gap-1">
          <Dropdown isOpen={branchOpen} onOpenChange={setBranchOpen}>
            <DropdownTrigger
              className={cx(
                "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border-button-default",
                "px-2 text-body-medium text-text-primary shadow-xs",
                "hover:bg-background-secondary-hover",
              )}
            >
              <GitBranch
                aria-hidden
                className="size-4 shrink-0 text-foreground-icon-secondary"
              />
              <span className="truncate">{status?.branch ?? "…"}</span>
              <ChevronDown
                aria-hidden
                className="ml-auto size-4 shrink-0 text-foreground-icon-tertiary"
              />
            </DropdownTrigger>
            <DropdownPopover aria-label={t("git.branch")} placement="bottom start">
              {(branches ?? []).map((b) => (
                <DropdownItem
                  key={b.name}
                  selected={b.isCurrent}
                  className="px-2 py-1.5"
                  onSelect={() => {
                    setBranchOpen(false);
                    if (!b.isCurrent) {
                      run("checkout", () =>
                        useGitStore.getState().checkout(workspacePath, b.name),
                      );
                    }
                  }}
                >
                  <span className="truncate text-body-medium text-text-primary">
                    {b.name}
                  </span>
                </DropdownItem>
              ))}
              <DropdownDivider />
              <DropdownItem
                className="px-2 py-1.5"
                onSelect={() => {
                  setBranchOpen(false);
                  setCreatingBranch(true);
                }}
              >
                <Plus aria-hidden className="size-4 text-foreground-icon-secondary" />
                <span className="text-body-medium text-text-primary">
                  {t("git.newBranch")}
                </span>
              </DropdownItem>
            </DropdownPopover>
          </Dropdown>
        </div>
      )}
      {creatingBranch && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranchName.trim();
            if (name.length === 0 || pending.createBranch === true) return;
            run("createBranch", async () => {
              await useGitStore.getState().createBranch(workspacePath, name);
              setCreatingBranch(false);
              setNewBranchName("");
            });
          }}
        >
          <input
            autoFocus
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder={t("git.branchNamePlaceholder")}
            className={cx(
              "h-8 min-w-0 flex-1 rounded-lg border border-border-button-default px-2",
              "text-body-medium text-text-primary placeholder:text-text-placeholder",
              "outline-none focus:border-border-focus-ring",
            )}
          />
          <Button
            size="small"
            type="submit"
            disabled={newBranchName.trim().length === 0 || pending.createBranch === true}
          >
            {t("common.confirm")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setCreatingBranch(false);
              setNewBranchName("");
            }}
          >
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {(actionError ?? refreshError) && (
        <p className="break-words text-xs text-text-error-primary">
          {actionError ?? refreshError}
        </p>
      )}
    </div>
  );

  if (notRepo) {
    return (
      <aside className={cx("flex h-full flex-col bg-background-primary-default", className)}>
        {header}
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-body-medium text-text-tertiary">
            {t("git.notARepo")}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cx("flex h-full flex-col bg-background-primary-default", className)}>
      {header}
      {diffTarget ? (
        <DiffView
          workspacePath={workspacePath}
          target={diffTarget}
          status={status}
          onBack={() => setDiffTarget(null)}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {!status ? (
            <div className="flex h-full items-center justify-center p-4">
              <p className="text-body-medium text-text-tertiary">{t("common.loading")}</p>
            </div>
          ) : status.staged.length + status.unstaged.length + status.untracked.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <p className="text-body-medium text-text-tertiary">{t("git.noChanges")}</p>
            </div>
          ) : (
            <>
              <ChangesSummary status={status} />
              <GroupSection
                title={t("git.staged")}
                entries={status.staged}
                groupActionLabel={t("git.unstageAll")}
                onGroupAction={unstage}
                rowActionLabel={t("git.unstage")}
                rowActionKind="unstage"
                onRowAction={unstageOne}
                onOpen={openStagedDiff}
                actionBusy={pending.unstage === true}
              />
              <GroupSection
                title={t("git.unstaged")}
                entries={status.unstaged}
                groupActionLabel={t("git.stageAll")}
                onGroupAction={stage}
                rowActionLabel={t("git.stage")}
                rowActionKind="stage"
                onRowAction={stageOne}
                onOpen={openUnstagedDiff}
                actionBusy={pending.stage === true}
              />
              <GroupSection
                title={t("git.untracked")}
                entries={status.untracked}
                groupActionLabel={t("git.stageAll")}
                onGroupAction={stage}
                rowActionLabel={t("git.stage")}
                rowActionKind="stage"
                onRowAction={stageOne}
                onOpen={openUnstagedDiff}
                actionBusy={pending.stage === true}
                isNew
              />
            </>
          )}
        </div>
      )}
      {!diffTarget && (
        <div className="flex flex-col gap-2 border-t border-separator-border p-3">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={t("git.commitMessage")}
            rows={2}
            className={cx(
              "w-full resize-none rounded-lg border border-border-button-default px-2 py-1.5",
              "text-body-medium text-text-primary placeholder:text-text-placeholder",
              "outline-none focus:border-border-focus-ring",
            )}
          />
          <Button
            className="self-stretch"
            disabled={
              (status?.staged.length ?? 0) === 0 ||
              commitMsg.trim().length === 0 ||
              pending.commit === true
            }
            onClick={() => {
              const message = commitMsg.trim();
              run("commit", async () => {
                await useGitStore.getState().commit(workspacePath, message);
                setCommitMsg("");
              });
            }}
          >
            {t("git.commit")}
          </Button>
        </div>
      )}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

function ChangesSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation();
  const all = [...status.staged, ...status.unstaged, ...status.untracked];
  const adds = all.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = all.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="sticky top-0 flex items-center gap-1.5 border-b border-separator-border bg-background-primary-default px-3 py-2">
      <span className="text-body-medium text-text-primary">
        {all.length} {t("git.uncommittedChanges")}
      </span>
      <span className="text-xs text-state-success-text">+{adds}</span>
      <span className="text-xs text-text-error-primary">−{dels}</span>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  M: "text-status-yellow-text",
  A: "text-state-success-text",
  D: "text-text-error-primary",
  R: "text-status-purple-text",
  C: "text-status-blue-text",
};

interface GroupSectionProps {
  title: string;
  entries: GitFileEntry[];
  groupActionLabel: string;
  onGroupAction: (files: string[]) => void;
  rowActionLabel: string;
  rowActionKind: "stage" | "unstage";
  onRowAction: (file: string) => void;
  onOpen: (file: string) => void;
  actionBusy: boolean;
  isNew?: boolean;
}

const GroupSection = memo(function GroupSection({
  title,
  entries,
  groupActionLabel,
  onGroupAction,
  rowActionLabel,
  rowActionKind,
  onRowAction,
  onOpen,
  actionBusy,
  isNew = false,
}: GroupSectionProps) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  return (
    <section>
      <div
        className={cx(
          "sticky top-0 flex items-center gap-1 bg-background-secondary-default px-3 py-1.5",
          "border-b border-separator-border",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-4 text-foreground-icon-tertiary" />
          ) : (
            <ChevronRight aria-hidden className="size-4 text-foreground-icon-tertiary" />
          )}
          <span className="text-body-medium text-text-secondary">{title}</span>
          <span className="text-xs text-text-tertiary">{entries.length}</span>
        </button>
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onGroupAction(entries.map((f) => f.path))}
          className={cx(
            "shrink-0 rounded px-1.5 py-0.5 text-xs text-text-secondary",
            "hover:bg-background-tertiary-hover disabled:text-text-disabled",
          )}
        >
          {groupActionLabel}
        </button>
      </div>
      {open && (
        <ul>
          {entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              actionLabel={rowActionLabel}
              actionKind={rowActionKind}
              onAction={onRowAction}
              onOpen={onOpen}
              actionBusy={actionBusy}
              isNew={isNew}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

interface FileRowProps {
  entry: GitFileEntry;
  actionLabel: string;
  actionKind: "stage" | "unstage";
  /** Untracked group: show the "New" badge like the template panel. */
  isNew?: boolean;
  onAction: (path: string) => void;
  onOpen: (path: string) => void;
  actionBusy: boolean;
}

const FileRow = memo(function FileRow({
  entry,
  actionLabel,
  actionKind,
  isNew = false,
  onAction,
  onOpen,
  actionBusy,
}: FileRowProps) {
  const { t } = useTranslation();
  const raw = entry.status.replace("?", "").trim().charAt(0).toUpperCase();
  const letter = raw.length > 0 ? raw : "?";
  return (
    <li className="group flex items-center gap-2 px-3 py-1 hover:bg-background-secondary-hover">
      <span
        className={cx(
          "w-4 shrink-0 text-center font-mono text-xs",
          STATUS_COLOR[letter] ?? "text-text-tertiary",
        )}
      >
        {letter}
      </span>
      <button
        type="button"
        onClick={() => onOpen(entry.path)}
        className="min-w-0 flex-1 truncate text-left font-mono text-xs text-text-primary"
        title={entry.path}
      >
        {entry.path}
      </button>
      {entry.additions !== undefined && (
        <span className="shrink-0 text-xs text-state-success-text">+{entry.additions}</span>
      )}
      {entry.deletions !== undefined && entry.deletions > 0 && (
        <span className="shrink-0 text-xs text-text-error-primary">−{entry.deletions}</span>
      )}
      {isNew && (
        <span className="shrink-0 rounded-sm bg-background-tertiary-default px-1 py-px text-caption-1-medium text-text-secondary">
          {t("git.newFile")}
        </span>
      )}
      <button
        type="button"
        disabled={actionBusy}
        onClick={() => onAction(entry.path)}
        aria-label={actionLabel}
        title={actionLabel}
        className={cx(
          "shrink-0 rounded p-0.5 text-foreground-icon-secondary opacity-0",
          // Reveal on row hover AND on keyboard focus (same contract as the
          // file-tree mention button).
          "group-hover:opacity-100 focus-visible:opacity-100 hover:bg-background-tertiary-hover",
          "disabled:text-foreground-icon-disabled",
        )}
      >
        {actionKind === "stage" ? (
          <Plus aria-hidden className="size-4" />
        ) : (
          <Minus aria-hidden className="size-4" />
        )}
      </button>
    </li>
  );
});
