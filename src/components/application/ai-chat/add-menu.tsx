"use client";

import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import Paperclip from "lucide-react/dist/esm/icons/paperclip";
import Crosshair from "lucide-react/dist/esm/icons/crosshair";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";

/**
 * Board UI → "ai_chat" dropdowns (nodes 4035:6313 / 4035:6925), adapted to
 * live data. Same react-aria non-modal popover recipe as the template;
 * contents are props-driven:
 * - AddMenu — the composer's plus button: "Add" popover
 *   (Figma 4040:5414); all rows render disabled until they get backends.
 */

/** The add menu is a custom, wider panel than the other popovers (Figma
 *  4040:5414): 361px, tighter 8px padding, grouped rows with inline muted
 *  descriptions. */
const ADD_POPOVER_CLASSES = menuPopoverSurface({
  width: "w-[361px]",
  origin: "origin-bottom-left",
  padding: "p-2",
});

/* ----------------------------------------------------------------- add menu */

interface AddMenuRow {
  label: string;
  /** Muted inline description after the label. */
  description?: string;
  /** 20px lucide rows ("Add" group). */
  icon?: typeof Paperclip;
  /** Wired action. Rows without one render disabled: no row has a backend
   *  yet. */
  onSelect?: () => void;
}

function AddMenuItem({ icon: Icon, label, description, onSelect }: AddMenuRow) {
  return (
    <button
      type="button"
      disabled={!onSelect}
      onClick={onSelect}
      className={cx(
        "flex w-full items-center gap-2 rounded-2lg px-2 py-1.5 outline-none transition-colors",
        onSelect
          ? "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
          : "cursor-not-allowed opacity-40",
      )}
    >
      {Icon && <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
      <span className="truncate text-body-medium whitespace-nowrap">
        <span className="text-text-primary">{label}</span>
        {description && <span className="ml-1.5 text-text-secondary">{description}</span>}
      </span>
    </button>
  );
}

function AddMenuGroup({ label, rows }: { label: string; rows: AddMenuRow[] }) {
  return (
    <div className="flex w-full flex-col gap-1.5 pt-1">
      <span className="pl-2 text-body-medium text-text-secondary">{label}</span>
      <div className="flex w-full flex-col gap-1">
        {rows.map((row) => (
          <AddMenuItem key={row.label} {...row} />
        ))}
      </div>
    </div>
  );
}

/**
 * Composer plus-button + "Add" popover (Figma node 4040:5414). Every row
 * renders disabled until it gets a real backend.
 */
export function AddMenu({
  disabled = false,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { t } = useTranslation();
  const { isOpen, triggerRef, popoverRef, setOpen } = usePopoverState();

  const addRows: AddMenuRow[] = [
    { icon: Paperclip, label: t("chat.addFilesFolders") },
    { icon: Crosshair, label: t("chat.addGoal"), description: t("chat.addGoalDesc") },
    { icon: ListChecks, label: t("chat.addPlanMode"), description: t("chat.addPlanModeDesc") },
  ];

  return (
    <AriaDialogTrigger
      isOpen={isOpen}
      onOpenChange={setOpen}
    >
      <span title={disabled ? disabledReason : undefined}>
      <AriaButton
        ref={triggerRef}
        aria-label={t("chat.attach")}
        isDisabled={disabled}
        className={cx(
          "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ai-chat-composer-add-background p-2 outline-none transition-colors duration-150 ease hover:bg-ai-chat-composer-add-hover-background focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <Plus
          className={cx(
            "size-5 text-foreground-icon-primary transition-transform duration-200 ease",
            isOpen && "rotate-45",
          )}
          aria-hidden
        />
      </AriaButton>
      </span>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top start"
        offset={8}
        className={ADD_POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("chat.attach")} className="flex flex-col gap-2 outline-none">
          <AddMenuGroup label={t("chat.attach")} rows={addRows} />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
