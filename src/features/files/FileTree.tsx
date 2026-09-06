import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { measureElement as defaultMeasureElement, useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import { cx } from "@/utils/cx";
import type { DirEntry } from "@/lib/ipc";
import { joinPath, useFilesStore } from "./store";
import { getFileTreeIconSvg } from "./fileIcons";
import { useChatStore } from "@/features/chat/store";

export interface VisibleNode extends DirEntry {
  path: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

interface TreeRowProps {
  node: VisibleNode;
  selected: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectDir: (path: string) => void;
  /** Hover "+": stage an @path mention in the active chat's composer. */
  onMention: (path: string) => void;
  mentionLabel: string;
}

const TreeRow = memo(function TreeRow({
  node,
  selected,
  onToggleDir,
  onOpenFile,
  onSelectDir,
  onMention,
  mentionLabel,
}: TreeRowProps) {
  const handleClick = useCallback(() => {
    if (node.isDir) {
      onSelectDir(node.path);
      onToggleDir(node.path);
    } else {
      onOpenFile(node.path);
    }
  }, [node.isDir, node.path, onToggleDir, onOpenFile, onSelectDir]);

  // Icon SVGs are static string constants; selection is a map/set lookup.
  const iconSvg = useMemo(
    () => getFileTreeIconSvg(node.name, node.isDir, node.expanded),
    [node.name, node.isDir, node.expanded],
  );

  return (
    <div
      className={cx(
        "group flex h-7 w-full items-center rounded-md pr-1 text-body-medium",
        "hover:bg-background-primary-hover",
        selected
          ? "bg-background-primary-active text-text-primary"
          : "text-text-primary",
      )}
      style={{ paddingLeft: 8 + node.depth * 14 }}
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        title={node.path}
      >
        {node.loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-foreground-icon-tertiary" aria-hidden />
        ) : (
          <span
            className={cx(
              "size-4 shrink-0 [&>svg]:size-4",
              node.isDir
                ? "text-foreground-icon-secondary"
                : "text-foreground-icon-tertiary",
            )}
            aria-hidden
            dangerouslySetInnerHTML={{ __html: iconSvg }}
          />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      <button
        type="button"
        aria-label={mentionLabel}
        title={mentionLabel}
        onClick={(e) => {
          e.stopPropagation();
          onMention(node.path);
        }}
        className="ml-auto hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-primary-active hover:text-text-primary group-hover:flex focus-visible:flex"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
});

export function FileTree() {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const children = useFilesStore((s) => s.children);
  const expanded = useFilesStore((s) => s.expanded);
  const loadingDirs = useFilesStore((s) => s.loadingDirs);
  const dirErrors = useFilesStore((s) => s.dirErrors);
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const ensureDir = useFilesStore((s) => s.ensureDir);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const selectPath = useFilesStore((s) => s.selectPath);
  const openFile = useFilesStore((s) => s.openFile);

  // Load the root level whenever it changes and hasn't been fetched yet.
  useEffect(() => {
    if (root) void ensureDir(root);
  }, [root, ensureDir]);

  const visible = useMemo<VisibleNode[]>(() => {
    const out: VisibleNode[] = [];
    const walk = (dirPath: string, depth: number) => {
      const entries = children[dirPath];
      if (!entries) return;
      for (const e of entries) {
        const path = joinPath(dirPath, e.name);
        out.push({
          ...e,
          path,
          depth,
          expanded: e.isDir && !!expanded[path],
          loading: e.isDir && !!loadingDirs[path],
        });
        // Only already-expanded levels are walked — the tree never loads
        // recursively; each expansion triggers exactly one listDir call.
        if (e.isDir && expanded[path]) walk(path, depth + 1);
      }
    };
    if (root) walk(root, 0);
    return out;
  }, [children, expanded, loadingDirs, root]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
    // Rows are recreated on every store update; key measurements by path so
    // expand/collapse/refresh never reassigns a cached size to the wrong row.
    getItemKey: (index) => visible[index]?.path ?? index,
    // ChatPage keeps this panel mounted under `display: none` while the
    // changes tab is active, and ResizeObserver then reports every rendered
    // row as 0px tall. virtual-core has no zero-size guard: accepting those
    // entries poisons itemSizeCache and fires phantom scroll adjustments
    // (writes dropped on the box-less scroller while scrollOffset eagerly
    // drifts), which can leave the virtualizer scrolled past real rows — a
    // blank band at the top of the tree. Keep the last known height instead.
    measureElement: (el, entry, instance) => {
      const size = defaultMeasureElement(el, entry, instance);
      if (size > 0) return size;
      const index = instance.indexFromElement(el);
      return (
        instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? 28
      );
    },
  });

  // Safety net for the same hidden→shown transition: if the DOM scroll
  // position and the virtualizer's offset still diverge (WKWebView restores
  // scrollTop without a scroll event), re-sync through the virtualizer's own
  // scroll pipeline. The synthetic event is a no-op when already in sync
  // (virtual-core's spurious-event guard).
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let lastHeight = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const height = el.getBoundingClientRect().height;
      if (lastHeight === 0 && height > 0) el.dispatchEvent(new Event("scroll"));
      lastHeight = height;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rootError = root ? dirErrors[root] : undefined;
  const rootLoading = root ? !!loadingDirs[root] : false;

  // Hover "+" on a row: insert an @path mention into the active chat's
  // composer (renders there as an inline chip). Files and folders alike.
  const handleMention = useCallback(
    (path: string) => useChatStore.getState().requestMention(path),
    [],
  );

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
      {rootError ? (
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          <p className="text-caption-1-regular text-text-error-primary break-all">{rootError}</p>
          <button
            type="button"
            onClick={() => void ensureDir(root)}
            className="text-caption-1-medium text-text-secondary underline underline-offset-2 hover:text-text-primary"
          >
            {t("common.refresh")}
          </button>
        </div>
      ) : rootLoading && visible.length === 0 ? (
        <p className="px-3 py-2 text-caption-1-regular text-text-tertiary">{t("common.loading")}</p>
      ) : visible.length === 0 ? (
        <p className="px-3 py-2 text-caption-1-regular text-text-tertiary">{t("files.emptyTree")}</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = visible[vi.index];
            return (
              <div
                key={node.path}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
                className="px-1"
              >
                <TreeRow
                  node={node}
                  selected={selectedPath === node.path}
                  onToggleDir={toggleDir}
                  onOpenFile={openFile}
                  onSelectDir={selectPath}
                  onMention={handleMention}
                  mentionLabel={t("files.addToChat")}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
