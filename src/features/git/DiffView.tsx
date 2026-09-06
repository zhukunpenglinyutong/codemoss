import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import { IconButton } from "@/components/base/buttons/icon-button";
import { ipc, type GitStatus } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { cx } from "@/utils/cx";

/* -------------------------------------------------------------------------- */

const DIFF_TRUNCATE_LINES = 2000;
const DIFF_VIRTUALIZE_LINES = 500;

export interface DiffTarget {
  file: string;
  staged: boolean;
}

export function DiffView({
  workspacePath,
  target,
  status,
  onBack,
}: {
  workspacePath: string;
  target: DiffTarget;
  status: GitStatus | undefined;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [diffText, setDiffText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reload when the target changes or when THIS file's status row changes
  // (stage/unstage flips its list membership, edits move add/del counts).
  // Depending on the whole `status` object reloaded the diff on every
  // background poll refresh — a new object each time — even when this file
  // was untouched.
  const entry = target.staged
    ? status?.staged.find((e) => e.path === target.file)
    : (status?.unstaged.find((e) => e.path === target.file) ??
      status?.untracked.find((e) => e.path === target.file));
  const entrySig = entry
    ? `${entry.status}:${entry.additions ?? ""}:${entry.deletions ?? ""}`
    : "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    ipc
      .gitDiff(workspacePath, target.file, target.staged)
      .then((text) => {
        if (!cancelled) setDiffText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, target.file, target.staged, entrySig]);

  const { lines, truncated } = useMemo<{ lines: AnnotatedLine[] | null; truncated: boolean }>(() => {
    if (diffText === null) return { lines: null, truncated: false };
    const all = diffText.split("\n");
    const over = all.length > DIFF_TRUNCATE_LINES;
    return { lines: annotateDiff(over ? all.slice(0, DIFF_TRUNCATE_LINES) : all), truncated: over };
  }, [diffText]);

  const virtualize = lines !== null && lines.length > DIFF_VIRTUALIZE_LINES;

  const rowVirtualizer = useVirtualizer({
    count: virtualize && lines ? lines.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 30,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-separator-border px-2 py-1.5">
        <IconButton
          icon={ArrowLeft}
          size="small"
          aria-label={t("git.back")}
          onClick={onBack}
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
          title={target.file}
        >
          {target.file}
        </span>
        <span className="shrink-0 text-xs text-text-tertiary">
          {target.staged ? t("git.staged") : t("git.unstaged")}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-3 text-xs text-text-error-primary">{error}</p>
        ) : lines === null ? (
          <p className="p-3 text-body-medium text-text-tertiary">{t("common.loading")}</p>
        ) : virtualize ? (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${row.start}px)`,
                }}
                className="w-full"
              >
                <DiffLine line={lines[row.index]} />
              </div>
            ))}
          </div>
        ) : (
          <div className="py-1">
            {lines.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </div>
        )}
        {truncated && lines !== null && (
          <p className="sticky bottom-0 bg-background-primary-default px-3 py-1.5 text-xs text-text-tertiary">
            {t("git.diffTooLarge")}
          </p>
        )}
      </div>
    </div>
  );
}

interface AnnotatedLine {
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Assign old/new line numbers from @@ hunk headers (unified diff). */
function annotateDiff(lines: string[]): AnnotatedLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { text, oldNo: null, newNo: null };
    }
    if (!inHunk) return { text, oldNo: null, newNo: null };
    if (text.startsWith("+")) return { text, oldNo: null, newNo: newLine++ };
    if (text.startsWith("-")) return { text, oldNo: oldLine++, newNo: null };
    return { text, oldNo: oldLine++, newNo: newLine++ };
  });
}

const DiffLine = memo(function DiffLine({ line }: { line: AnnotatedLine }) {
  const text = line.text;
  const kind =
    text.startsWith("+") && !text.startsWith("+++")
      ? "add"
      : text.startsWith("-") && !text.startsWith("---")
        ? "del"
        : text.startsWith("@@")
          ? "hunk"
          : null;
  return (
    <div
      className={cx(
        "flex whitespace-pre-wrap break-all font-mono text-xs leading-5",
        kind === "add" && "bg-green-500/10",
        kind === "del" && "bg-red-500/10",
      )}
    >
      <span className="w-9 shrink-0 pr-2 text-right text-text-tertiary select-none">
        {line.oldNo ?? ""}
      </span>
      <span className="w-9 shrink-0 pr-2 text-right text-text-tertiary select-none">
        {line.newNo ?? ""}
      </span>
      <span
        className={cx(
          "min-w-0 flex-1 pr-3",
          kind === "add" && "text-state-success-text",
          kind === "del" && "text-text-error-primary",
          kind === "hunk" && "text-status-blue-text",
          kind === null && "text-text-secondary",
        )}
      >
        {text.length > 0 ? text : " "}
      </span>
    </div>
  );
});
