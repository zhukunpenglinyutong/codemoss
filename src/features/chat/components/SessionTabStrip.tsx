import X from "lucide-react/dist/esm/icons/x";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ReactNode, MouseEvent, KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cx } from "@/utils/cx";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";

// Overlay titlebar leaves the native traffic lights floating over the
// strip's left edge on macOS; other platforms keep their own titlebar.
const IS_MAC =
  typeof navigator !== "undefined" && /macintosh|mac os x/i.test(navigator.userAgent);

// Interactive elements keep their click behavior; any other press inside the
// strip (empty padding, container wrappers, panel header blanks) starts a
// window drag. data-tauri-drag-region alone only fires when the press lands
// on the element carrying the attribute, never on its children — so the
// nested containers swallowing most of the titlebar could not drag.
const DRAG_IGNORE_SELECTOR = "button, a, input, textarea, select, [role='tab']";

function handleStripMouseDown(e: MouseEvent<HTMLDivElement>) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) return;
  e.preventDefault();
  void getCurrentWindow().startDragging();
}

export interface SessionTabItem {
  key: string;
  label: string;
  streaming: boolean;
  /** Engine (CLI) id, shown as a brand mark before the label. */
  engine?: string;
  /** Icon for non-session tabs (e.g. files); takes precedence over engine. */
  icon?: LucideIcon;
  /** Finished activity the user has not opened yet — solid green dot. */
  unseen?: boolean;
  /** Unsaved-changes dot before the label. */
  dirty?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
}

interface SessionTabStripProps {
  tabs: SessionTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  closeLabel: string;
  /** Buttons pinned to the strip's right edge, outside the scrolling tabs. */
  actions?: ReactNode;
  /** Node pinned left of the tabs (e.g. a sidebar expand button). */
  leading?: ReactNode;
  /** Reserve the macOS traffic-light inset; turn off while the full-height
   *  sidebar owns the titlebar's left edge. Default true. */
  trafficLightInset?: boolean;
}

/**
 * Conversation tab strip doubling as the window drag region (overlay
 * titlebar). Clicks land on tab elements; only the strip's own padding
 * starts a window drag. Tabs scroll horizontally without a scrollbar and
 * vertical wheel deltas translate to horizontal scroll, like VSCode.
 */
export function SessionTabStrip({
  tabs,
  activeKey,
  onSelect,
  onClose,
  closeLabel,
  actions,
  leading,
  trafficLightInset = true,
}: SessionTabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // Vertical wheel drives the horizontal tab scroll (VSCode behavior).
  // Native non-passive listener: React wheel handlers cannot preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX === 0 && e.deltaY === 0) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab in view as tabs stream in/out of the strip.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeKey) return;
    el.querySelector(`[data-tab-key="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  // Roving-tabindex tab list: Arrow keys move focus between tabs (selection
  // still requires Enter/Space, matching the platform tab convention).
  function handleTabListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const el = scrollRef.current;
    if (!el) return;
    const tabEls = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = tabEls.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowRight"
        ? (current + 1) % tabEls.length
        : (current - 1 + tabEls.length) % tabEls.length;
    tabEls[next]?.focus();
  }

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleStripMouseDown}
      className={cx(
        "flex h-10 shrink-0 items-center border-b border-separator-border select-none",
        IS_MAC && trafficLightInset && "pl-[80px]",
      )}
    >
      {leading && <div className="flex h-full shrink-0 items-center pl-2">{leading}</div>}
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="tabs"
        onKeyDown={handleTabListKeyDown}
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
      >
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        const TabIcon = tab.icon;
        return (
          <div
            key={tab.key}
            data-tab-key={tab.key}
            role="tab"
            aria-selected={isActive}
            aria-controls="center-tabpanel"
            tabIndex={isActive ? 0 : -1}
            title={tab.title ?? tab.label}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(tab.key);
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.key);
            }}
            className={cx(
              "group flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 text-body-medium transition-colors",
              isActive
                ? "bg-background-secondary-default text-text-primary"
                : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
            )}
          >
            {TabIcon ? (
              <TabIcon
                className="size-3 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
            ) : (
              <EngineIcon
                engine={tab.engine ?? ""}
                size={12}
                className="size-3 shrink-0 text-foreground-icon-secondary"
              />
            )}
            {/* Same status dots as the sidebar: breathing blue while the
             * turn streams, solid green for unseen finished activity. */}
            {tab.streaming ? (
              <span
                className="sidebar-thread-status sidebar-thread-status-processing"
                role="status"
                aria-label={t("chat.sessionRunning")}
                title={t("chat.sessionRunning")}
              />
            ) : tab.unseen ? (
              <span
                className="sidebar-thread-status sidebar-thread-status-unseen"
                aria-label={t("chat.sessionUnseen")}
                title={t("chat.sessionUnseen")}
              />
            ) : null}
            {tab.dirty && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-icon-primary" />
            )}
            <span className="truncate">{tab.label}</span>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.key);
              }}
              className={cx(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-foreground-icon-primary",
                // Keyboard users must see the button when it has focus, not
                // only on pointer hover.
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      </div>
      {actions && (
        <div className="flex h-full shrink-0 items-center">
          {actions}
        </div>
      )}
    </div>
  );
}
