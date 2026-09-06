"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { cx } from "@/utils/cx";

/**
 * Agent Thinking — the agent "thinking" state that sits above a chat composer
 * while a response is being worked on.
 *
 * Four curated variants:
 * - `wave`     dot grid with a diagonal wavefront gliding top-left → bottom-right
 * - `spin`     dot grid with a bright head orbiting the grid clockwise
 * - `stars`    sparkles twinkling in and out with a stagger
 * - `infinity` a comet trail sweeping a figure-eight
 *
 * Every variant pairs the indicator with a shimmering label and an elapsed
 * timer that starts when the loader mounts. Shimmer and CSS animations fall
 * back to static rendering under `prefers-reduced-motion` (see globals.css).
 */

export type AgentThinkingVariant = "wave" | "spin" | "stars" | "infinity";
export type AgentThinkingTone = "subtle" | "default" | "primary" | "accent";

export interface AgentThinkingProps {
  variant?: AgentThinkingVariant;
  /** Status label, e.g. "Thinking" or "Searching the docs" — required, already
   *  localized by the caller (i18n lives in feature code). */
  label: string;
  /** Tone of the indicator + label. Defaults per variant (`stars` is subtle). */
  tone?: AgentThinkingTone;
  /** Animated highlight traveling across the label. */
  shimmer?: boolean;
  /** Elapsed seconds since mount, rendered after the label. */
  showTimer?: boolean;
  /** Epoch ms the timed work began. When set, the timer counts from this
   * fixed origin instead of mount time, so an unmount/remount cycle keeps
   * counting instead of restarting from 0. */
  startedAt?: number;
  className?: string;
}

const TONE_COLORS: Record<AgentThinkingTone, string> = {
  subtle: "var(--color-text-tertiary)",
  default: "var(--color-text-secondary)",
  primary: "var(--color-text-primary)",
  accent: "var(--color-blue-500)",
};

const VARIANT_TONE: Record<AgentThinkingVariant, AgentThinkingTone> = {
  wave: "default",
  spin: "default",
  stars: "subtle",
  infinity: "default",
};

/* ------------------------------------------------------------------- dots */

const DOTS_GRID = 3;
const DOTS_SIZE = 4;
const DOTS_GAP = 2;
const DOTS_TICK_MS = 80;
const DOTS_FADE_MS = 220;
const DOTS_TRAIL = 0.3;
const DOTS_MIN_OPACITY = 0.12;
const DOTS_PHASE_STEP = 1 / 8;

// Static first frame: identical on server and client, and the resting state
// under prefers-reduced-motion.
const DOTS_SEED = [0.55, 0.3, 0.15, 0.85, 0.55, 0.3, 1, 0.85, 0.55];

/**
 * How far along the pattern's travel direction each cell sits, in [0, 1),
 * precomputed per variant at module scope: the scalars never change, so the
 * 80ms tick below only runs the phase math, not nine atan2 calls a frame.
 * The wave scalar is compressed below 1 so the phase wrap reads as the front
 * leaving the grid and re-entering; the spin angle is naturally cyclic.
 */
const DOT_SCALARS: Record<"wave" | "spin", number[]> = {
  wave: Array.from({ length: DOTS_GRID * DOTS_GRID }, (_, i) => {
    const m = DOTS_GRID - 1;
    return ((i % DOTS_GRID + Math.floor(i / DOTS_GRID)) / (2 * m)) * (DOTS_GRID / (DOTS_GRID + 1));
  }),
  spin: Array.from({ length: DOTS_GRID * DOTS_GRID }, (_, i) => {
    const center = (DOTS_GRID - 1) / 2;
    return (Math.atan2(Math.floor(i / DOTS_GRID) - center, (i % DOTS_GRID) - center) / (2 * Math.PI) + 1) % 1;
  }),
};

function dotOpacities(variant: "wave" | "spin", phase: number) {
  return DOT_SCALARS[variant].map((s) => {
    // Comet: bright head at the phase front, tail fading behind it.
    const behind = (phase - s + 1) % 1;
    const lit = Math.max(0, 1 - behind / DOTS_TRAIL) ** 1.5;
    return DOTS_MIN_OPACITY + (1 - DOTS_MIN_OPACITY) * lit;
  });
}

function DotsIndicator({ variant }: { variant: "wave" | "spin" }) {
  const [opacities, setOpacities] = useState<number[]>(DOTS_SEED);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let phase = 0;
    const id = window.setInterval(() => {
      phase = (phase + DOTS_PHASE_STEP) % 1;
      setOpacities(dotOpacities(variant, phase));
    }, DOTS_TICK_MS);
    return () => window.clearInterval(id);
  }, [variant]);

  return (
    <span
      aria-hidden
      className="grid shrink-0"
      style={{
        gridTemplateColumns: `repeat(${DOTS_GRID}, ${DOTS_SIZE}px)`,
        gap: DOTS_GAP,
      }}
    >
      {opacities.map((opacity, i) => (
        <span
          key={i}
          className="rounded-[1px] bg-current"
          style={{
            width: DOTS_SIZE,
            height: DOTS_SIZE,
            opacity,
            transition: `opacity ${DOTS_FADE_MS}ms ease`,
          }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ stars */

const STAR_PERIOD_S = 1.4;
const STAR_SIZE = 14;
const STAR_COUNT = 5;
const STAR_LAYOUT = [
  { x: 50, y: 46, scale: 1 },
  { x: 18, y: 22, scale: 0.55 },
  { x: 82, y: 26, scale: 0.45 },
  { x: 78, y: 76, scale: 0.55 },
  { x: 22, y: 78, scale: 0.4 },
];
const STAR_PATH = "M12 0C13 7 17 11 24 12C17 13 13 17 12 24C11 17 7 13 0 12C7 11 11 7 12 0Z";
const STAR_BOX = STAR_SIZE * 1.5;

// Fully static: the same tree on every render, so build it once.
const STARS_INDICATOR = (
  <span
    aria-hidden
    className="bui-agent-thinking-stars relative block shrink-0"
    style={{ width: STAR_BOX, height: STAR_BOX }}
  >
    {STAR_LAYOUT.slice(0, STAR_COUNT).map((star, i) => {
      const size = STAR_SIZE * star.scale;
      return (
        <svg
          key={i}
          viewBox="0 0 24 24"
          className="bui-agent-thinking-star absolute"
          style={{
            width: size,
            height: size,
            left: `${star.x}%`,
            top: `${star.y}%`,
            marginLeft: -size / 2,
            marginTop: -size / 2,
            animationDuration: `${STAR_PERIOD_S}s`,
            animationDelay: `${(i * STAR_PERIOD_S * 0.7) / STAR_COUNT}s`,
          }}
        >
          <path d={STAR_PATH} fill="currentColor" />
        </svg>
      );
    })}
  </span>
);

function StarsIndicator() {
  return STARS_INDICATOR;
}

/* --------------------------------------------------------------- infinity */

const INFINITY_WIDTH = 32;
const INFINITY_TRAIL = 11;
const INFINITY_STROKE = 2.75;
const INFINITY_DURATION_S = 1.2;
const INFINITY_PATH =
  "M28 14C33 5 47 5 47 14C47 23 33 23 28 14C23 5 9 5 9 14C9 23 23 23 28 14Z";

function InfinityIndicator() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 56 28"
      className="shrink-0"
      // The figure-eight spans x 9-47 of the 56-wide viewBox, so the svg box
      // carries ~4px of dead space per side at this width; pull it back in so
      // the label sits at the loader's real gap.
      style={{ width: INFINITY_WIDTH, height: INFINITY_WIDTH / 2, margin: "0 -4px" }}
    >
      <path
        d={INFINITY_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        opacity={0.15}
      />
      <path
        d={INFINITY_PATH}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${INFINITY_TRAIL} ${100 - INFINITY_TRAIL}`}
        className="bui-agent-thinking-comet"
        style={{ animationDuration: `${INFINITY_DURATION_S}s` }}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ timer */

/** Under 60s: "12.3s"; 60s+: "2m12s"; 1h+: "1h23m" (finer units are noise at that scale). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m${Math.floor(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function ElapsedTimer({ startedAt }: { startedAt?: number }) {
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0,
  );

  useEffect(() => {
    if (startedAt) {
      const id = window.setInterval(
        () => setElapsed(Math.max(0, (Date.now() - startedAt) / 1000)),
        100,
      );
      return () => window.clearInterval(id);
    }
    const started = performance.now();
    const id = window.setInterval(
      () => setElapsed((performance.now() - started) / 1000),
      100,
    );
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <span className="font-mono text-caption-1-regular text-text-tertiary tabular-nums">
      {formatElapsed(elapsed)}
    </span>
  );
}

/* ----------------------------------------------------------------- loader */

export function AgentThinking({
  variant = "wave",
  label,
  tone,
  shimmer = true,
  showTimer = true,
  startedAt,
  className,
}: AgentThinkingProps) {
  const color = TONE_COLORS[tone ?? VARIANT_TONE[variant]];

  return (
    <div
      role="status"
      className={cx("flex items-center gap-2.5", className)}
      style={{ color, "--bui-agent-thinking-tone": color } as CSSProperties}
    >
      {(variant === "wave" || variant === "spin") && <DotsIndicator variant={variant} />}
      {variant === "stars" && <StarsIndicator />}
      {variant === "infinity" && <InfinityIndicator />}
      <span
        aria-label={label}
        className={cx("text-body-medium", shimmer && "bui-agent-thinking-label")}
      >
        {label}
      </span>
      {showTimer && <ElapsedTimer startedAt={startedAt} />}
    </div>
  );
}
