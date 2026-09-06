import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Plus from "lucide-react/dist/esm/icons/plus";
import X from "lucide-react/dist/esm/icons/x";
import { cx } from "@/utils/cx";
import { TERMINAL_MAX_HEIGHT, TERMINAL_MIN_HEIGHT, useTerminalStore } from "./store";
import { TerminalView } from "./TerminalView";

const HEADER_BUTTON_CLASSES = cx(
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors",
  "text-foreground-icon-tertiary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
);

/**
 * Bottom dock: tab strip + one PTY-backed shell per tab, shells running in
 * the active workspace. Height drags commit through the store once per
 * animation frame; storage persistence is debounced inside the store.
 */
export function TerminalDock({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const open = useTerminalStore((s) => s.open);
  const height = useTerminalStore((s) => s.height);
  const tabs = useTerminalStore((s) => s.tabsByWorkspace[workspacePath]);
  const activeId = useTerminalStore((s) => s.activeByWorkspace[workspacePath]);
  const closePanel = useTerminalStore((s) => s.closePanel);
  const newTab = useTerminalStore((s) => s.newTab);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setHeight = useTerminalStore((s) => s.setHeight);

  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const dragHeight = useRef(0);
  const rafRef = useRef(0);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStartY.current = e.clientY;
      dragStartHeight.current = height;
      setDragging(true);
    },
    [height],
  );
  // Tabs live in memory only: if the panel is open for a workspace with no
  // tabs yet (e.g. another workspace was just removed), create the shell.
  useEffect(() => {
    if (open && !tabs?.length) newTab(workspacePath);
  }, [open, tabs?.length, workspacePath, newTab]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      // The dock grows upward. The delta is measured from the drag start —
      // basing it on the last committed height would compound every move.
      dragHeight.current = Math.min(
        TERMINAL_MAX_HEIGHT,
        Math.max(TERMINAL_MIN_HEIGHT, dragStartHeight.current + dragStartY.current - e.clientY),
      );
      // Pointermove can outpace frames; one store commit per frame keeps the
      // section's rendered height authoritative (imperative style writes got
      // snapped back whenever a parent re-rendered mid-drag).
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          setHeight(dragHeight.current);
        });
      }
    };
    const onUp = () => {
      setDragging(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      setHeight(dragHeight.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [dragging, setHeight]);

  if (!open) return null;

  const tabList = tabs ?? [];

  return (
    <section
      className={cx(
        "relative flex shrink-0 flex-col border-t border-separator-border bg-background-full",
        dragging && "select-none",
      )}
      style={{ height }}
      aria-label={t("terminal.toggle")}
    >
      {/* Top-edge resize strip, straddling the border. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("terminal.resizePanel")}
        title={t("terminal.resizePanel")}
        onPointerDown={onResizeStart}
        className="group absolute inset-x-0 -top-1 z-30 h-2 cursor-row-resize touch-none"
      >
        <span
          className={cx(
            "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-foreground-icon-quaternary opacity-0 transition-opacity group-hover:opacity-100",
            dragging && "opacity-100",
          )}
        />
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-separator-border px-2">
        <button
          type="button"
          title={t("terminal.hidePanel")}
          aria-label={t("terminal.hidePanel")}
          onClick={closePanel}
          className={HEADER_BUTTON_CLASSES}
        >
          <ChevronDown className="size-4" aria-hidden />
        </button>
        <div role="tablist" aria-label={t("terminal.toggle")} className="flex min-w-0 items-center">
          {tabList.map((tab, index) => {
            const selected = tab.id === activeId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(workspacePath, tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectTab(workspacePath, tab.id);
                  }
                }}
                className={cx(
                  "group flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-caption-1-medium transition-colors",
                  selected
                    ? "bg-background-secondary-hover text-text-primary"
                    : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
                )}
              >
                <span className="whitespace-nowrap">
                  {t("terminal.tabTitle", { index: index + 1 })}
                </span>
                <button
                  type="button"
                  title={t("terminal.closeTerminal")}
                  aria-label={t("terminal.closeTerminal")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(workspacePath, tab.id);
                  }}
                  className={cx(
                    "flex size-4 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-foreground-icon-primary",
                    !selected && "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            title={t("terminal.newTerminal")}
            aria-label={t("terminal.newTerminal")}
            onClick={() => newTab(workspacePath)}
            className={HEADER_BUTTON_CLASSES}
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {activeId && <TerminalView key={activeId} id={activeId} cwd={workspacePath} />}
    </section>
  );
}
