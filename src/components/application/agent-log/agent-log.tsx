"use client";

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { motion } from "motion/react";
import { cx } from "@/utils/cx";

/**
 * Agent Log — the shared machinery behind a streaming agent transcript.
 *
 * A line of work drawing itself down the page: rows arrive one at a time,
 * each blurring in while a curved guide strokes itself alongside them. All of
 * that lives here so consumers cannot drift apart, and so tuning the motion
 * means tuning it once.
 *
 * What is here: the blur-in transition and its soft clipping edge, the
 * shimmer for a line still in progress, and the tree guide with its draw
 * animation. What is not here: anything about what a row *says*. That is each
 * component's own business.
 */

/* --------------------------------------------------------------- motion */

export const SOFT_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Each unit blurs in as it lands: 6px of blur and a 4px lift resolving over
 * 0.42s, the same language the AI Chat thread uses for a streaming line. The
 * height runs a touch shorter on the soft curve so the row has finished making
 * space slightly before the text finishes sharpening — the container settles
 * first, then the words arrive, which is what reads as smooth rather than as a
 * jump.
 *
 * Growing a row from height 0 means `overflow-hidden` cuts a hard line through
 * the text while it emerges. `--bui-reveal-fade` softens that edge: the row is
 * masked with a gradient whose solid portion ends that many pixels short of the
 * bottom, and the reveal animates it to 0, at which point the mask is a no-op
 * and nothing pops. The fade is longer than a text line, so a row is always
 * faintest exactly where it is being clipped.
 */
const REVEAL_FADE_VAR = "--bui-reveal-fade";

// The transparent stop sits just past the box: with both stops at exactly 100%
// the gradient is degenerate and browsers soften the final pixel row, which
// shows up as breaks in the guide where one row meets the next.
const REVEAL_GRADIENT = `linear-gradient(to bottom, #000 calc(100% - var(${REVEAL_FADE_VAR}, 0px)), transparent calc(100% + 1px))`;

const REVEAL_MASK: CSSProperties = {
  WebkitMaskImage: REVEAL_GRADIENT,
  maskImage: REVEAL_GRADIENT,
};

export const UNIT_INITIAL = {
  opacity: 0,
  height: 0,
  y: 4,
  filter: "blur(6px)",
  [REVEAL_FADE_VAR]: "22px",
};

export const UNIT_ANIMATE = {
  opacity: 1,
  height: "auto",
  y: 0,
  filter: "blur(0px)",
  [REVEAL_FADE_VAR]: "0px",
};

export const UNIT_TRANSITION = {
  height: { duration: 0.38, ease: SOFT_EASE },
  opacity: { duration: 0.42, ease: SOFT_EASE },
  filter: { duration: 0.42, ease: SOFT_EASE },
  y: { duration: 0.42, ease: SOFT_EASE },
  [REVEAL_FADE_VAR]: { duration: 0.44, ease: SOFT_EASE },
};

/**
 * The soft edge only earns its keep while a unit is growing. Once the reveal
 * finishes, drop the mask entirely: no compositing layer at rest, and the guide
 * meets pixel-exactly at every row boundary.
 */
export function useRevealMask(reduce: boolean) {
  const [revealing, setRevealing] = useState(!reduce);
  return {
    style: revealing ? REVEAL_MASK : undefined,
    onAnimationComplete: () => setRevealing(false),
  };
}

/** A line the agent is still working on, with a highlight travelling across it. */
export function ShimmerText({ children }: { children: string }) {
  return (
    <span aria-label={children} className="agent-progress-loading-text">
      {children}
    </span>
  );
}

/* ----------------------------------------------------------- tree guide */

/* Branch geometry. The elbow sits a fixed distance from the row's top rather
 * than at 50%, so a row whose label wraps still branches at its first line
 * instead of drifting to the middle of the block. 14px is half of the 20px line
 * plus the row's 4px top padding. */
const BRANCH_Y = 14;
const BRANCH_RADIUS = 6;
const BRANCH_WIDTH = 12;

/** Down the trunk, round the corner, out to the label. */
const BRANCH_PATH = `M0.5 0 V${BRANCH_Y - BRANCH_RADIUS} Q0.5 ${BRANCH_Y} ${0.5 + BRANCH_RADIUS} ${BRANCH_Y} H11.5`;

/**
 * The guide draws as one pen, which means the pieces run in sequence rather
 * than together.
 *
 * When a row arrives, the line still has to cover the row above it: that row
 * was the last one a moment ago, so its trunk stopped at its own corner. Its
 * tail draws first, down through the space the new row just opened; only then
 * does the new row's branch start, picking the stroke up exactly where the tail
 * left it. Run both at once — which is what happens if they share a delay — and
 * you get two disconnected fragments per row, which reads as a column of
 * separate cells instead of a single line.
 *
 * Timings are lengths divided by one pen speed, ~160px/s, so the stroke never
 * changes pace as it hands off. `linear` matters here: an eased draw would slow
 * at every junction and give the handoff away.
 *
 * The chain is sized against how fast the label *reads*, not against its
 * nominal duration. The blur-in runs 0.42s but on a steeply front-loaded curve,
 * so the words have settled by roughly 0.2s; sizing the guide to the full 0.42s
 * left it visibly trailing text that was already done. The 42px of line
 * therefore draws in 0.26s, starting on the same frame as the row.
 */
const TAIL_TRANSITION = { duration: 0.12, ease: "linear" as const, delay: 0 };

/** A branch waits for the tail above it; the first in a list has none to wait
 *  for and starts with the row. */
const branchTransition = (first: boolean) => ({
  duration: 0.14,
  ease: "linear" as const,
  delay: first ? 0 : 0.12,
});

/**
 * Curved tree guide, matching the docs sidebar and the AI Chat repository
 * submenus, drawn per row rather than as one measured SVG for the whole list.
 * These rows have variable height and animate their height as they arrive; a
 * row that owns its own elbow stays correct through all of that with no
 * measurement.
 *
 * Two pieces, because a single stroke cannot fork. The branch is an SVG path
 * animating `pathLength`, which is the part you watch being drawn. The trunk
 * below it is a 1px bar scaling from its top edge, which extends downward on
 * the same curve and meets the next row's branch. The last row omits it, so the
 * guide finishes on the corner instead of hanging past it.
 */
export function RowConnector({
  first,
  last,
  reduce,
}: {
  first: boolean;
  last: boolean;
  reduce: boolean;
}) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 w-3 text-foreground-icon-quaternary"
    >
      <svg
        width={BRANCH_WIDTH}
        height={BRANCH_Y + 1}
        viewBox={`0 0 ${BRANCH_WIDTH} ${BRANCH_Y + 1}`}
        fill="none"
        className="absolute top-0 left-0"
      >
        <motion.path
          d={BRANCH_PATH}
          stroke="currentColor"
          strokeWidth="1"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={branchTransition(first)}
        />
      </svg>
      {!last && (
        <motion.span
          className="absolute left-0 w-px origin-top bg-current"
          style={{ top: BRANCH_Y - BRANCH_RADIUS, bottom: 0 }}
          initial={reduce ? false : { scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={TAIL_TRANSITION}
        />
      )}
    </span>
  );
}

/**
 * One row of a log: the blur-in, the clipping edge that keeps it from being cut
 * as it grows, and the length of guide that belongs to it.
 */
export function LogRow({
  first,
  last,
  reduce,
  className,
  children,
}: {
  first: boolean;
  last: boolean;
  reduce: boolean;
  className?: string;
  children: ReactNode;
}) {
  const mask = useRevealMask(reduce);
  return (
    <motion.li
      initial={reduce ? false : UNIT_INITIAL}
      animate={UNIT_ANIMATE}
      transition={UNIT_TRANSITION}
      {...mask}
      className={cx("relative overflow-hidden pl-4", className)}
    >
      <RowConnector first={first} last={last} reduce={reduce} />
      {children}
    </motion.li>
  );
}
