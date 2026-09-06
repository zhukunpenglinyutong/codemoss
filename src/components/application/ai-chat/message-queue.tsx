import { useTranslation } from "react-i18next";
import ImageIcon from "lucide-react/dist/esm/icons/image";
import X from "lucide-react/dist/esm/icons/x";
import type { QueuedMessage } from "@/features/chat/store";
import { cx } from "@/utils/cx";

/**
 * Floating card above the composer listing messages queued while a turn
 * streams. Numbering follows the send order: #1 sits closest to the input
 * and drains first. Rows render newest-first so the next message to send is
 * at the bottom, matching the reference desktop-cc-gui queue card.
 */

const PREVIEW_LIMIT = 120;

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= PREVIEW_LIMIT
    ? normalized
    : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`;
}

export interface MessageQueueProps {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  className?: string;
}

export function MessageQueue({ queue, onRemove, className }: MessageQueueProps) {
  const { t } = useTranslation();
  if (queue.length === 0) return null;

  return (
    <div
      className={cx(
        "flex max-h-28 flex-col gap-1 overflow-y-auto rounded-2xl border border-separator-border bg-background-primary-default p-1.5 shadow-dropdown",
        className,
      )}
    >
      {[...queue].reverse().map((item, reversedIndex) => {
        const position = queue.length - reversedIndex;
        return (
          <div
            key={item.id}
            className="group grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-background-secondary-hover"
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-button-primary text-caption-2-medium text-text-white">
              {position}
            </span>
            <span
              className="min-w-0 truncate text-body-regular text-text-primary"
              title={item.text}
              aria-label={item.text}
            >
              {item.images.length > 0 && (
                <span
                  className="mr-1.5 inline-flex items-center gap-0.5 rounded-md bg-background-tertiary-default px-1 py-px align-middle text-caption-1-medium text-text-secondary"
                  title={t("chat.queueImages", { count: item.images.length })}
                >
                  <ImageIcon className="size-3" aria-hidden />
                  {item.images.length}
                </span>
              )}
              {preview(item.text)}
            </span>
            <button
              type="button"
              aria-label={t("chat.queueRemove")}
              title={t("chat.queueRemove")}
              onClick={() => onRemove(item.id)}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-foreground-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background-tertiary-hover hover:text-foreground-icon-primary"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
