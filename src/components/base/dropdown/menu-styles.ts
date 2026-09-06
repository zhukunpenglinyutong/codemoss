/**
 * Shared visual recipe for BoardUI menu surfaces.
 *
 * Select and Dropdown intentionally keep their distinct React Aria semantics
 * (single-value listbox vs. action menu), while consuming the same panel,
 * motion, and row treatments from here.
 */

/** Enter/exit motion shared by every popover surface in the app. */
const MENU_POPOVER_MOTION = [
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
].join(" ");

export const MENU_POPOVER_SURFACE = [
  "max-w-[calc(100vw-32px)] overflow-y-auto",
  "rounded-2xl border border-border-button-default bg-background-primary-default p-2.5 shadow-dropdown",
  MENU_POPOVER_MOTION,
  "data-[placement=bottom]:origin-top-left data-[placement=top]:origin-bottom-left",
  "data-[placement=left]:origin-right data-[placement=right]:origin-left",
].join(" ");

/**
 * Fixed-placement popover surface (ai-chat menus, header actions): unlike
 * MENU_POPOVER_SURFACE these pin one placement, so they take an explicit
 * origin and width instead of data-[placement] origins, and skip the
 * overflow scroll (their content sizes itself).
 */
export function menuPopoverSurface({
  width,
  origin,
  radius = "rounded-2xl",
  padding = "p-2.5",
}: {
  /** Tailwind width class, e.g. "w-[266px]". */
  width: string;
  /** Transform origin matching the pinned placement, e.g. "origin-bottom-left". */
  origin: string;
  radius?: string;
  padding?: string;
}): string {
  return [
    `${width} max-w-[calc(100vw-32px)] ${origin}`,
    `${radius} border border-border-button-default bg-background-primary-default ${padding} shadow-dropdown`,
    MENU_POPOVER_MOTION,
  ].join(" ");
}

export const MENU_POPOVER_WIDTH = "w-[266px]";

export const MENU_ITEMS_CONTAINER = "flex w-full flex-col gap-1 outline-none";

export const MENU_ITEM = [
  "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-left",
  "text-text-primary outline-none transition-colors",
].join(" ");

export const MENU_ITEM_ACTIVE = "bg-dropdown-item-hover-background";

export const MENU_ITEM_INTERACTIVE =
  "hover:bg-dropdown-item-hover-background focus-visible:bg-dropdown-item-hover-background";
