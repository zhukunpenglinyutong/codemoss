"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import X from "lucide-react/dist/esm/icons/x";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { cx } from "@/utils/cx";

/**
 * Figma sources: Board UI → "Settings/Profile" (node 4081:13943) and
 * "Settings/General" (node 4079:13037).
 *
 * The app-wide settings modal, opened from the sidebar's "Settings" item.
 * The shell is content-agnostic: nav groups, page titles, and page bodies
 * come in as props so feature code owns the actual settings.
 *
 * Shell (1:1 with Figma):
 *   backdrop  overlay-backdrop scrim token.
 *   panel     871×614 (max-height 614), radius/3xl (24px), shadow/xs.
 *   rail      274px, bg background/secondary, 1px right border, p 10 —
 *             same group/item recipe as the board-team dropdown menus
 *             (label pl-8, items p-8 radius/2lg icon-20 + body-medium),
 *             selected row bg background/secondary/hover.
 *   content   px 32 (274 + 32 = Figma's 306 title inset), title row fixed,
 *             the page itself scrolls when taller than the shell.
 *
 * Built on react-aria's Modal/ModalOverlay/Dialog — the same stack as
 * components/dialogs.tsx — which owns role/aria-modal, the focus trap,
 * Escape and backdrop dismissal, and portalling. Open/close animation: the
 * panel fades + blurs in from scale 0.85 (300ms), the backdrop cross-fades;
 * the same transition plays in reverse on close via data-entering/exiting,
 * and react-aria keeps the modal mounted until the exit transition finishes.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface SettingsNavItem {
  key: string;
  label: string;
  icon: IconComponent;
}

export interface SettingsNavGroup {
  /** Muted group heading; omit for an unlabeled group. */
  label?: string;
  items: SettingsNavItem[];
}

export interface SettingsModalProps {
  /** Controlled open state, owned by the host page, sidebar, or menu. */
  isOpen: boolean;
  /** Called by the backdrop, close button, and Escape key. */
  onClose: () => void;
  /** Page selected each time the modal opens. */
  defaultPage?: string;
  /** Dialog label (visible title row uses the page title). */
  ariaLabel: string;
  groups: SettingsNavGroup[];
  titles: Record<string, string>;
  renderPage: (key: string) => ReactNode;
}

export function SettingsModal({
  isOpen,
  onClose,
  defaultPage,
  ariaLabel,
  groups,
  titles,
  renderPage,
}: SettingsModalProps) {
  const firstKey = groups[0]?.items[0]?.key ?? "general";
  const [page, setPage] = useState<string>(defaultPage ?? firstKey);

  // Top fade over the scrolling page so rows dissolve under the title row
  // instead of cutting sharply (same recipe as the medical alerts feed).
  const [contentScrolled, setContentScrolled] = useState(false);

  // Reset to the default page each time the modal opens.
  useEffect(() => {
    if (isOpen) setPage(defaultPage ?? firstKey);
  }, [isOpen]); // defaultPage/firstKey only matter at the open transition

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={cx(
        "fixed inset-0 z-100 flex items-center justify-center p-4 bg-overlay-backdrop",
        "transition-opacity duration-300 ease-out",
        "data-[entering]:opacity-0 data-[exiting]:opacity-0",
      )}
    >
      <Modal
        isDismissable
        className={cx(
          "relative",
          // Kept light on purpose: an 8px blur over the full 871×614 panel
          // forces a huge re-filter every frame of the scale-down, which is
          // what made the close stutter. 4px + GPU promotion stays smooth.
          "transform-gpu transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[opacity,transform,filter]",
          "data-[entering]:scale-[0.85] data-[entering]:opacity-0 data-[entering]:blur-[4px]",
          "data-[exiting]:scale-[0.85] data-[exiting]:opacity-0 data-[exiting]:blur-[4px]",
        )}
      >
        <Dialog
          aria-label={ariaLabel}
          className={cx(
            "relative flex h-[614px] max-h-[calc(100dvh-32px)] w-[871px] max-w-[calc(100vw-32px)]",
            // overflow-CLIP, not hidden: hidden boxes are still programmatically
            // scrollable, so focusing a switch's hidden input in a row clipped
            // by the inner scroller made the browser scroll-reveal it through
            // the panel too — shifting the whole modal content up with no way
            // back. clip forbids scrolling outright.
            "overflow-clip rounded-3xl bg-background-full shadow-xs outline-none",
          )}
        >
          {/* Nav rail — the board-team dropdown group/item recipe */}
          <nav
            aria-label={ariaLabel}
            className="flex w-[274px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-separator-border bg-background-secondary-default p-2.5"
          >
            {groups.map((group, groupIndex) => (
              <div
                key={group.label ?? groupIndex}
                className="flex w-full flex-col gap-1.5 pt-1"
              >
                {group.label && (
                  <span className="pl-2 text-body-medium text-text-secondary">{group.label}</span>
                )}
                <div className="flex w-full flex-col gap-1">
                  {group.items.map((item) => {
                    const selected = item.key === page;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => {
                          setPage(item.key);
                          setContentScrolled(false);
                        }}
                        className={cx(
                          "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-left",
                          "outline-none transition-colors duration-150 ease focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                          selected
                            ? "bg-background-secondary-hover"
                            : "hover:bg-background-secondary-hover/60",
                        )}
                      >
                        <item.icon
                          className="size-5 shrink-0 text-foreground-icon-secondary"
                          aria-hidden
                        />
                        <span
                          className={cx(
                            "truncate text-body-medium",
                            selected ? "text-text-primary" : "text-text-secondary",
                          )}
                        >
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Content pane — fixed title row, scrollable page below */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between px-8 pt-8 pb-3">
              <h2 className="text-title-3-medium text-text-primary">
                {titles[page] ?? page}
              </h2>
              <button
                type="button"
                aria-label={ariaLabel}
                onClick={onClose}
                className={cx(
                  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full",
                  "bg-background-tertiary-default text-foreground-icon-secondary",
                  "transition-colors duration-150 ease hover:bg-background-tertiary-hover",
                  "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                )}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              <div
                className="h-full overflow-y-auto px-8 pb-8"
                onScroll={(e) => setContentScrolled(e.currentTarget.scrollTop > 0)}
              >
                {renderPage(page)}
              </div>
              {/* Progressive top fade — eases in once the page is scrolled so
                  content dissolves under the title row instead of hard-cutting. */}
              <div
                aria-hidden
                className={cx(
                  "pointer-events-none absolute inset-x-0 top-0 h-10 bg-linear-to-b from-background-primary-default to-transparent",
                  "transition-opacity duration-200 ease-out",
                  contentScrolled ? "opacity-100" : "opacity-0",
                )}
              />
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
