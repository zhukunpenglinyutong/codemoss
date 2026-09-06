import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import Ellipsis from "lucide-react/dist/esm/icons/ellipsis";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { useFilesStore } from "@/features/files/store";
import { useTerminalStore } from "@/features/terminal/store";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import {
  OPEN_APP_ICONS,
  OPEN_APP_TARGETS,
  TERMINAL_ACTION_ID,
  openPathInTarget,
  readPinnedIds,
  readSelectedOpenAppId,
  resolveOpenAppPath,
  writePinnedIds,
  writeSelectedOpenAppId,
  type OpenAppTarget,
} from "./open-app";

/**
 * Titlebar cluster migrated from the legacy MainHeader: pinned "open in"
 * targets, the terminal dock toggle, and the "更多" menu holding every open
 * target plus the terminal row, each with a pin checkbox controlling header
 * visibility.
 */

const ICON_BUTTON_CLASSES = cx(
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
);

const POPOVER_CLASSES = menuPopoverSurface({
  width: "w-[240px]",
  origin: "origin-top-right",
  padding: "p-1.5",
});

export function HeaderOpenActions({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  // Editors open the file shown in the active editor tab; Finder always
  // reveals the workspace folder.
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const terminalOpen = useTerminalStore((s) => s.open);
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const [pinnedIds, setPinnedIds] = useState(readPinnedIds);
  const [selectedId, setSelectedId] = useState(readSelectedOpenAppId);
  const {
    isOpen: menuOpen,
    triggerRef,
    popoverRef,
    close: closeMenu,
    setOpen,
  } = usePopoverState();

  const openTarget = useCallback(
    async (target: OpenAppTarget) => {
      const path = resolveOpenAppPath(target, { workspacePath, activeFilePath });
      try {
        await openPathInTarget(path, target);
      } catch {
        // Silent by design: the target app is typically just not installed,
        // and the header cluster has no error surface worth interrupting for.
      }
    },
    [workspacePath, activeFilePath],
  );

  const handleSelectTarget = useCallback(
    (target: OpenAppTarget) => {
      setSelectedId(target.id);
      writeSelectedOpenAppId(target.id);
      closeMenu();
      void openTarget(target);
    },
    [openTarget],
  );

  const togglePinned = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      writePinnedIds(next);
      return next;
    });
  }, []);

  const terminalPinned = pinnedIds.includes(TERMINAL_ACTION_ID);
  const terminalLabel = t("openApp.terminal");
  const showInHeaderLabel = t("openApp.showInHeader");

  return (
    <div className="flex items-center gap-0.5 px-1.5">
      {OPEN_APP_TARGETS.filter((target) => pinnedIds.includes(target.id)).map((target) => (
        <button
          key={target.id}
          type="button"
          title={t("openApp.openIn", { target: target.label })}
          aria-label={t("openApp.openIn", { target: target.label })}
          onClick={() => void openTarget(target)}
          className={ICON_BUTTON_CLASSES}
        >
          <img src={OPEN_APP_ICONS[target.id]} alt="" aria-hidden className="size-4" />
        </button>
      ))}
      {terminalPinned && (
        <button
          type="button"
          title={terminalLabel}
          aria-label={terminalLabel}
          aria-pressed={terminalOpen}
          onClick={() => toggleTerminal(workspacePath)}
          className={cx(
            ICON_BUTTON_CLASSES,
            terminalOpen && "bg-background-secondary-hover text-foreground-icon-primary",
          )}
        >
          <SquareTerminal className="size-4" aria-hidden />
        </button>
      )}
      <AriaDialogTrigger
        isOpen={menuOpen}
        onOpenChange={setOpen}
      >
        <AriaButton
          ref={triggerRef}
          aria-label={t("openApp.more")}
          className={ICON_BUTTON_CLASSES}
        >
          <Ellipsis className="size-4" aria-hidden />
        </AriaButton>
        <AriaPopover
          ref={popoverRef}
          isNonModal
          placement="bottom end"
          offset={6}
          className={POPOVER_CLASSES}
        >
          <AriaDialog aria-label={t("openApp.more")} className="outline-none">
            <div className="flex w-full flex-col gap-0.5">
              {OPEN_APP_TARGETS.map((target) => (
                <div
                  key={target.id}
                  className={cx(
                    "flex items-center gap-1 rounded-2lg pr-1.5",
                    target.id === selectedId && "bg-background-secondary-default",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectTarget(target)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-2lg p-2 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
                  >
                    <img
                      src={OPEN_APP_ICONS[target.id]}
                      alt=""
                      aria-hidden
                      className="size-4 shrink-0"
                    />
                    <span className="truncate text-body-medium text-text-primary">
                      {target.label}
                    </span>
                  </button>
                  <Checkbox
                    size="sm"
                    isSelected={pinnedIds.includes(target.id)}
                    onChange={() => togglePinned(target.id)}
                    aria-label={showInHeaderLabel}
                  />
                </div>
              ))}
              <div className="flex items-center gap-1 rounded-2lg pr-1.5">
                <button
                  type="button"
                  onClick={() => {
                    toggleTerminal(workspacePath);
                    closeMenu();
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-2lg p-2 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
                >
                  <SquareTerminal
                    className="size-4 shrink-0 text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-body-medium text-text-primary">
                    {terminalLabel}
                  </span>
                </button>
                <Checkbox
                  size="sm"
                  isSelected={terminalPinned}
                  onChange={() => togglePinned(TERMINAL_ACTION_ID)}
                  aria-label={showInHeaderLabel}
                />
              </div>
            </div>
          </AriaDialog>
        </AriaPopover>
      </AriaDialogTrigger>
    </div>
  );
}
