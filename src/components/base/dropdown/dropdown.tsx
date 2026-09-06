"use client";

import { createContext, useContext, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEM_INTERACTIVE,
  MENU_POPOVER_SURFACE,
  MENU_POPOVER_WIDTH,
} from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";

/**
 * Dropdown — the BoardUI popover-menu recipe as composable primitives, built
 * on React Aria's DialogTrigger/Popover. Unlike Select (which picks a value
 * into a trigger), Dropdown is a free-form menu surface: grouped rows of
 * actions, headers, footers, whatever the panel needs.
 *
 * The same recipe powers the dashboard sidebar's team/account menus and the
 * AI chat template's add/model/folder menus:
 *
 * - Panel: white, 1px border/button/default, radius 16, p 10, shadow/dropdown.
 * - Appear animation: 150ms fade + scale-95 + 2px blur in and out.
 * - Rows: rounded-2lg, background/secondary/hover on hover and on the selected
 *   row, body-medium labels, 4px apart (the panel's flex column carries a
 *   gap-1, the same rhythm as the Select listbox).
 *
 * Composition:
 *
 * ```tsx
 * <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
 *   <DropdownTrigger>Open</DropdownTrigger>
 *   <DropdownPopover aria-label="Actions" placement="bottom start">
 *     <DropdownGroup label="Add">
 *       <DropdownItem onSelect={close}>…row content…</DropdownItem>
 *     </DropdownGroup>
 *     <DropdownDivider />
 *     <DropdownGroup label="Plugins">…</DropdownGroup>
 *   </DropdownPopover>
 * </Dropdown>
 * ```
 *
 * State can be uncontrolled (omit isOpen/onOpenChange) — control it when the
 * trigger needs to react to the open state (e.g. rotating a chevron).
 */

/* ------------------------------------------------------------------- shell */

interface DropdownContextValue {
  triggerRef: RefObject<HTMLButtonElement>;
  popoverRef: RefObject<HTMLElement>;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

export interface DropdownProps {
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** Trigger (a DropdownTrigger) followed by a DropdownPopover. */
  children: ReactNode;
}

/**
 * The popover is `isNonModal`: react-aria's modal scroll lock puts
 * `overflow: hidden` on <html>, which collapses the page scroll position and
 * visibly yanks sticky layout (e.g. the docs sidebar) whenever a menu opens.
 * Non-modal skips the lock, but react-aria hard-couples outside-press
 * dismissal to modality — so open state lives here (bridging any controlled
 * props) and dismissal is restored via useDismissOnOutsidePress, the same
 * fix as Select and the date-picker family.
 */
export function Dropdown({ isOpen: controlledOpen, onOpenChange, children }: DropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);

  const isOpen = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  useDismissOnOutsidePress(isOpen, () => setOpen(false), [triggerRef, popoverRef]);
  // Pressing the trigger while open closes the menu instead of reopening
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);

  return (
    <DropdownContext.Provider value={{ triggerRef, popoverRef }}>
      <AriaDialogTrigger isOpen={isOpen} onOpenChange={(o) => allowOpenChange(o) && setOpen(o)}>
        {children}
      </AriaDialogTrigger>
    </DropdownContext.Provider>
  );
}

/** The element that opens the menu. Style it entirely via className. */
export function DropdownTrigger({ className, ...props }: ComponentProps<typeof AriaButton>) {
  const context = useContext(DropdownContext);
  return (
    <AriaButton
      ref={context?.triggerRef}
      {...props}
      className={cx(
        "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        className as string,
      )}
    />
  );
}

/* ------------------------------------------------------------------- panel */

export interface DropdownPopoverProps
  extends Pick<ComponentProps<typeof AriaPopover>, "placement" | "offset" | "crossOffset"> {
  "aria-label": string;
  /** Extra classes on the panel — e.g. a width override (default w-[266px]). */
  className?: string;
  /** Classes on the inner dialog (the flex column), e.g. gap between groups. */
  dialogClassName?: string;
  children: ReactNode;
}

export function DropdownPopover({
  "aria-label": ariaLabel,
  placement = "bottom start",
  offset = 4,
  crossOffset,
  className,
  dialogClassName,
  children,
}: DropdownPopoverProps) {
  const context = useContext(DropdownContext);
  return (
    <AriaPopover
      ref={context?.popoverRef}
      isNonModal
      placement={placement}
      offset={offset}
      crossOffset={crossOffset}
      className={cx(
        MENU_POPOVER_WIDTH,
        MENU_POPOVER_SURFACE,
        className,
      )}
    >
      {/* gap-1 keeps bare DropdownItems 4px apart, the same rhythm as the
          Select listbox; DropdownDivider's margins are sized to absorb it. */}
      <AriaDialog aria-label={ariaLabel} className={cx("flex flex-col gap-1 outline-none", dialogClassName)}>
        {children}
      </AriaDialog>
    </AriaPopover>
  );
}

/* ----------------------------------------------------------------- content */

export interface DropdownGroupProps {
  /** Muted body-medium heading above the rows. */
  label?: string;
  className?: string;
  children: ReactNode;
}

export function DropdownGroup({ label, className, children }: DropdownGroupProps) {
  return (
    // pt-1 is spacing for the group LABEL — a label-less group must not
    // carry it, or its first row floats 4px lower than the panel padding
    // implies (visible as extra space above the first item's hover pill).
    <div className={cx("flex w-full flex-col gap-1.5", label && "pt-1", className)}>
      {label && <span className="pl-2 text-body-medium text-text-secondary">{label}</span>}
      <div className="flex w-full flex-col gap-1">{children}</div>
    </div>
  );
}

export interface DropdownItemProps {
  /** Highlights the row like the hover state (current selection). */
  selected?: boolean;
  onSelect?: () => void;
  /** Row padding defaults to p-2 — override for denser rows (px-2 py-1.5). */
  className?: string;
  children: ReactNode;
}

/**
 * A menu row. Content is free-form — icon + label, avatar + name, label +
 * trailing badge — laid out in a gap-2 flex row.
 */
export function DropdownItem({ selected, onSelect, className, children }: DropdownItemProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        MENU_ITEM,
        selected ? MENU_ITEM_ACTIVE : MENU_ITEM_INTERACTIVE,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Full-bleed 1px divider between groups (bleeds through the panel's p-2.5).
 *  my-1.5 + the dialog's gap-1 on both sides = the original 10px breathing room. */
export function DropdownDivider({ className }: { className?: string }) {
  return <div className={cx("-mx-2.5 my-1.5 h-px shrink-0 bg-border-button-default", className)} />;
}
