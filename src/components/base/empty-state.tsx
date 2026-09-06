import type { HTMLAttributes, Ref } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { cx } from "@/utils/cx";

export interface CenteredSpinnerProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

/** Full-area loading state: a spinning loader centered in the flex parent. */
export function CenteredSpinner({ className, ref, ...props }: CenteredSpinnerProps) {
  return (
    <div
      ref={ref}
      className={cx("flex flex-1 items-center justify-center text-text-tertiary", className)}
      {...props}
    >
      <Loader2 className="size-5 animate-spin" aria-hidden />
    </div>
  );
}

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

/**
 * Full-area placeholder for a panel with nothing to show: content centered
 * in the flex parent, tertiary text color. Extra classes (padding, flex-col
 * for stacked messages) come in via `className`.
 */
export function EmptyState({ className, ref, ...props }: EmptyStateProps) {
  return (
    <div
      ref={ref}
      className={cx("flex flex-1 items-center justify-center text-text-tertiary", className)}
      {...props}
    />
  );
}
