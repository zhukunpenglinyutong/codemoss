"use client";

import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Folder from "lucide-react/dist/esm/icons/folder";
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
 * - ProjectFolderMenu — workspace picker opened from the status bar.
 */

const POPOVER_CLASSES = menuPopoverSurface({ width: "w-[266px]", origin: "origin-bottom-left" });

/* ---------------------------------------------------------- project folders */

/** Status-bar trigger + workspace popover (Figma node 4035:6313). */
export function ProjectFolderMenu({
  folders,
  selectedName,
  onSelect,
}: {
  /** Workspace folder display names, e.g. "desktop-cc-gui". */
  folders: string[];
  selectedName?: string;
  onSelect?: (name: string) => void;
}) {
  const { t } = useTranslation();
  // `isNonModal` popovers don't dismiss on outside press and don't toggle
  // closed on a trigger press — usePopoverState restores both (hook doc).
  const { isOpen, triggerRef, popoverRef, close, setOpen } = usePopoverState();

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <AriaButton
        ref={triggerRef}
        className="flex cursor-pointer items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <Folder className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="flex items-center">
          <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
            {selectedName ?? t("chat.noProjectSelected")}
          </span>
          <ChevronDown
            className={cx(
              "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200 ease",
              isOpen && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top start"
        offset={8}
        className={POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("chat.workspaces")} className="outline-none">
          <div className="flex w-full flex-col gap-1.5 pt-1">
            <span className="pl-2 text-body-medium text-text-secondary">
              {t("chat.workspaces")}
            </span>
            <div className="flex w-full flex-col gap-1">
              {folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  aria-pressed={folder === selectedName}
                  onClick={() => {
                    onSelect?.(folder);
                    close();
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 outline-none transition-colors",
                    folder === selectedName
                      ? "bg-background-primary-hover"
                      : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                  )}
                >
                  <Folder
                    className="size-5 shrink-0 text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
                    {folder}
                  </span>
                  {folder === selectedName && (
                    <Check
                      className="ml-auto size-4 shrink-0 text-foreground-icon-secondary"
                      aria-hidden
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
