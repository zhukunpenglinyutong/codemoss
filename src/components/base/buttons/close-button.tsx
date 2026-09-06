import type { ButtonHTMLAttributes, Ref } from "react";
import { cx, sortCx } from "@/utils/cx";

/**
 * Compact circular dismiss control — the "X" used to close announcements,
 * toasts, modals, and drawers. Companion to `IconButton`, but ships its own
 * glyph (rather than taking an `icon` prop) so every consumer gets an
 * identical X with a stroke that's a true CSS pixel value per size, not a
 * scaled approximation.
 *
 * The glyph is a hand-drawn SVG per size (not a shared icon scaled up/down)
 * because scaling a single glyph across sizes scales its stroke too — a 2px
 * line at 20px becomes ~3.2px at 32px. Each size below renders its own X in a
 * viewBox equal to its own pixel dimensions, so `strokeWidth` is always a
 * literal CSS pixel value, at every size (not a scaled approximation).
 *
 * Sizes (px):
 *   2xs = 16 container, 6.8px glyph, 1.6px stroke   (compact floating surfaces)
 *   xs = 20 container, 10.8px glyph, 2px stroke     (Announcement dismiss corner)
 *   sm = 24 container, 12.6px glyph, 2px stroke
 *   md = 32 container, 16.2px glyph, 2.5px stroke   (modal header close — a touch
 *                                                     bolder to hold its own at
 *                                                     the larger size)
 *
 * Glyph sizes are 90% of the container's natural proportion (12/14/18 → the
 * above), tuned down 10% across the board so the X reads a touch smaller
 * inside its circle.
 */

type CloseButtonSize = "2xs" | "xs" | "sm" | "md";

export interface CloseButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  size?: CloseButtonSize;
  /** Accessible name — required since there is no visible label. */
  "aria-label": string;
  ref?: Ref<HTMLButtonElement>;
}

const GLYPH_SIZE: Record<CloseButtonSize, number> = {
  "2xs": 6.8,
  xs: 10.8,
  sm: 12.6,
  md: 16.2,
};

const STROKE_WIDTH: Record<CloseButtonSize, number> = {
  "2xs": 1.6,
  xs: 2,
  sm: 2,
  md: 2.5,
};

const GLYPH_INSET: Record<CloseButtonSize, number> = {
  // Figma's 8px bars rotate inside a 6.8px square, leaving ~0.57px at
  // each corner once projected onto the diagonal.
  "2xs": 0.57,
  xs: 2,
  sm: 2,
  md: 2,
};

const styles = sortCx({
  base: [
    "inline-flex shrink-0 items-center justify-center rounded-full",
    "bg-background-tertiary-default text-foreground-icon-secondary",
    "select-none cursor-pointer",
    "transition-colors duration-150 ease",
    "hover:text-text-primary",
    "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring",
  ].join(" "),
  container: {
    "2xs": "size-4",
    xs: "size-5",
    sm: "size-6",
    md: "size-8",
  },
});

export function CloseButton({
  size = "xs",
  className,
  type = "button",
  ref,
  ...props
}: CloseButtonProps) {
  const glyph = GLYPH_SIZE[size];
  const strokeWidth = STROKE_WIDTH[size];
  const inset = GLYPH_INSET[size];

  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.base, styles.container[size], className)}
      {...props}
    >
      <svg width={glyph} height={glyph} viewBox={`0 0 ${glyph} ${glyph}`} fill="none" aria-hidden>
        <path
          d={`M${inset} ${inset}L${glyph - inset} ${glyph - inset}`}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        <path
          d={`M${glyph - inset} ${inset}L${inset} ${glyph - inset}`}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
