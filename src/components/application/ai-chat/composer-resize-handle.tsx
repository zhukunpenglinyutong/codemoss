import type {
  ComponentPropsWithoutRef,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/utils/cx";

/**
 * ComposerResizeHandle — the top-center grip that vertically resizes the
 * composer, ported from desktop-cc-gui's ResizeHandles:
 * - 18px hover zone floating just above the composer; the 54×4px pill only
 *   reveals on hover, while dragging, or when the composer is collapsed
 * - drag up/down resizes; drag below the minimum collapses the composer;
 *   click or ArrowUp on a collapsed composer expands it again
 * - keyboard: ArrowUp/ArrowDown nudge by 8px (24px with Shift)
 */
export function ComposerResizeHandle({
  getHandleProps,
  nudge,
  isResizing = false,
  isCollapsed = false,
}: {
  getHandleProps: () => ComponentPropsWithoutRef<"div">;
  nudge: (delta: { wrapperHeightPx?: number }) => void;
  isResizing?: boolean;
  isCollapsed?: boolean;
}) {
  const { t } = useTranslation();

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 24 : 8;

    const key = e.key;
    if (key !== "ArrowUp" && key !== "ArrowDown") {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (key === "ArrowUp") nudge({ wrapperHeightPx: step });
    if (key === "ArrowDown") nudge({ wrapperHeightPx: -step });
  };

  return (
    <div className="group absolute inset-x-0 -top-5 z-10 h-[18px] cursor-default">
      <div className="absolute top-0 left-1/2 flex h-[18px] -translate-x-1/2 items-center">
        <div
          {...getHandleProps()}
          onClick={(event) => {
            if (!isCollapsed) return;
            event.preventDefault();
            event.stopPropagation();
            nudge({ wrapperHeightPx: 24 });
          }}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("chat.resizeInput")}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="relative h-[18px] w-[54px] cursor-pointer touch-none select-none"
        >
          <div
            aria-hidden
            className={cx(
              "absolute top-1/2 left-1/2 h-1 w-[54px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-tertiary opacity-0 transition-[opacity,transform,background-color] duration-150 ease",
              "group-hover:opacity-55 group-hover:bg-text-secondary group-active:scale-x-112 group-active:scale-y-108 group-active:opacity-80",
              (isResizing || isCollapsed) && "bg-text-secondary opacity-70",
            )}
          />
        </div>
      </div>
    </div>
  );
}
