"use client";

import { useMemo, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "@/utils/cx";

/** Series colours: explicit `color` (+ optional `activeColor`) wins;
 * otherwise the `chart-n` token palette cycles in an order that keeps
 * neighbouring segments distinct. A custom colour without a hover step is
 * darkened with `color-mix` so hover still reads. */
type ChartTone = { color: string; activeColor: string };

const TONE_ORDER = [2, 6, 5, 3, 8, 7, 4, 1] as const;

const CHART_TONES: ChartTone[] = TONE_ORDER.map((n) => ({
  color: `var(--color-chart-${n})`,
  activeColor: `var(--color-chart-${n}-active)`,
}));

function resolveTone(index: number, color?: string, activeColor?: string): ChartTone {
  if (color) {
    return { color, activeColor: activeColor ?? `color-mix(in srgb, ${color} 82%, black)` };
  }
  return CHART_TONES[index % CHART_TONES.length];
}

/**
 * Agent limits card - the "how much of my agent budget is left" widget:
 *
 *   Context window   stacked usage bar (one segment per token bucket) with a
 *                    "used / max (pct)" readout. Expanding it grows the whole
 *                    card to reveal the breakdown: a legend row per bucket
 *                    (swatch · label · tokens · share), free space, deferred
 *                    buckets that don't count against the window ("—"), and
 *                    collapsible groups (MCP tools, memory files…) listing
 *                    their members.
 *   Plan limits      one row per rolling limit: label, reset time, percent,
 *                    and a progress bar.
 *
 * All numbers are props: `context.max` + `context.segments[]` drive the bar
 * and shares, `context.groups[]` the collapsible rows, `limits[]` the plan
 * section. Segment colours cycle the chart palette from blue unless set.
 */

export type ContextSegment = {
  label: string;
  tokens: number;
  /** Any CSS colour; defaults to the chart palette by index (blue first). */
  color?: string;
  /** Deferred buckets are listed but neither drawn in the bar nor counted. */
  deferred?: boolean;
};

export type ContextGroup = {
  label: string;
  tokens: number;
  items: { label: string; tokens: number }[];
};

export type UsageLimit = {
  label: string;
  /** 0-1 share of the limit already used. */
  used: number;
  /** "Resets in 2 hr 46 min", "Resets Tue 3:00 PM"… */
  resets: string;
};

export interface AgentLimitsCardProps {
  context: {
    /** Window size in tokens (e.g. 1_000_000). */
    max: number;
    segments: ContextSegment[];
    groups?: ContextGroup[];
  };
  /** Plan name shown after "Plan usage limits ·". */
  plan?: string;
  /** Where the plan arrow points (omit to hide the arrow). */
  planHref?: string;
  limits?: UsageLimit[];
  /** Start with the context breakdown open. */
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Copy, already localized by the caller (i18n lives in feature code). */
  text: {
    contextWindow: string;
    freeSpace: string;
    planUsageLimits: string;
    /** aria-label for the plan link arrow (rendered only with `planHref`). */
    managePlan: string;
  };
  className?: string;
}

/** 482_800 → "482.8k", 96_000 → "96k", 1_000_000 → "1M", 314 → "314". */
export function formatTokens(n: number) {
  const short = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n >= 1_000_000) return `${short(n / 1_000_000)}M`;
  if (n >= 1_000) return `${short(n / 1_000)}k`;
  return String(n);
}

const EASE = [0.22, 1, 0.36, 1] as const;

/** Thin rounded track + fill, the same bar the earnings/steps cards use. */
function Bar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-chart-track", className)}>
      {children}
    </div>
  );
}

export function AgentLimitsCard({
  context,
  plan,
  planHref,
  limits = [],
  defaultExpanded = false,
  onExpandedChange,
  text,
  className,
}: AgentLimitsCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const counted = useMemo(() => context.segments.filter((s) => !s.deferred), [context.segments]);
  const used = useMemo(() => counted.reduce((sum, s) => sum + s.tokens, 0), [counted]);
  const free = useMemo(() => Math.max(0, context.max - used), [context.max, used]);
  const share = (n: number) => (n / Math.max(1, context.max)) * 100;
  const tones = useMemo(
    () => context.segments.map((s, i) => resolveTone(i + 1, s.color)),
    [context.segments],
  );

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    onExpandedChange?.(next);
  };

  const toggleGroup = (label: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <section
      className={cx(
        "flex w-full min-w-0 flex-col rounded-2xl bg-background-secondary-default px-4 pt-2.5 pb-4",
        className,
      )}
    >
      {/* ---------------------------------------------- context window */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="group -mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-2lg px-2 py-1 text-left outline-none transition-colors duration-150 hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span className="text-body-medium text-text-secondary">{text.contextWindow}</span>
        <span className="flex items-center gap-2">
          <span className="text-body-medium whitespace-nowrap text-text-secondary tabular-nums">
            {formatTokens(used)} / {formatTokens(context.max)}{" "}
            <span className="text-text-primary">({Math.round(share(used))}%)</span>
          </span>
          <ChevronDown
            className={cx(
              "size-4 shrink-0 text-text-tertiary transition-transform duration-200 ease-out group-hover:text-text-secondary",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </button>

      <Bar className="mt-1.5">
        {context.segments.map((s, i) =>
          s.deferred ? null : (
            <div
              key={s.label}
              className="h-full shrink-0 transition-[width] duration-500 ease-out"
              style={{ width: `${share(s.tokens)}%`, backgroundColor: tones[i].color }}
              title={`${s.label} · ${formatTokens(s.tokens)}`}
            />
          ),
        )}
      </Bar>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="breakdown"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: EASE }}
            // The panel clips for the height animation, so it bleeds 8px past
            // the content and pads back in - the hover pills on the rows below
            // extend into that gutter and keep their rounded corners.
            className="-mx-2 overflow-hidden px-2"
          >
            <div className="flex flex-col pt-3">
              {context.segments.map((s, i) => (
                <div key={s.label} className="flex items-center gap-2 py-[5px]">
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: s.deferred ? "var(--color-chart-cursor)" : tones[i].color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-body-regular text-text-primary">{s.label}</span>
                  <span className="text-body-regular text-text-tertiary tabular-nums">{formatTokens(s.tokens)}</span>
                  <span className="w-14 text-right text-body-medium text-text-primary tabular-nums">
                    {s.deferred ? "—" : `${share(s.tokens).toFixed(1)}%`}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 py-[5px]">
                <span className="size-2.5 shrink-0 rounded-[3px] bg-chart-track" />
                <span className="min-w-0 flex-1 truncate text-body-regular text-text-primary">{text.freeSpace}</span>
                <span className="text-body-regular text-text-tertiary tabular-nums">{formatTokens(free)}</span>
                <span className="w-14 text-right text-body-medium text-text-primary tabular-nums">
                  {share(free).toFixed(1)}%
                </span>
              </div>

              {context.groups && context.groups.length > 0 && (
                <div className="mt-1.5 flex flex-col">
                  {context.groups.map((g) => {
                    const open = openGroups.has(g.label);
                    return (
                      <div key={g.label} className="flex flex-col">
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.label)}
                          aria-expanded={open}
                          className="-mx-2 flex cursor-pointer items-center gap-1.5 rounded-2lg px-2 py-[7px] text-left outline-none transition-colors duration-150 hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                        >
                          <ChevronRight
                            className={cx(
                              "size-4 shrink-0 text-text-tertiary transition-transform duration-200 ease-out",
                              open && "rotate-90",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-body-regular text-text-secondary">{g.label}</span>
                          <span className="text-body-regular text-text-tertiary tabular-nums">{formatTokens(g.tokens)}</span>
                          <span className="w-14 text-right text-body-regular text-text-tertiary tabular-nums">
                            {g.items.length}
                          </span>
                        </button>
                        <AnimatePresence initial={false}>
                          {open && (
                            <motion.div
                              key="items"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.26, ease: EASE }}
                              className="overflow-hidden"
                            >
                              <div className="flex flex-col pb-1 pl-[22px]">
                                {g.items.map((item) => (
                                  <div key={item.label} className="flex items-center gap-2 py-1">
                                    <span className="min-w-0 flex-1 truncate text-body-2-regular text-text-secondary">
                                      {item.label}
                                    </span>
                                    <span className="text-body-2-regular text-text-tertiary tabular-nums">
                                      {formatTokens(item.tokens)}
                                    </span>
                                    <span className="w-14" />
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------------------------------------------------- plan limits */}
      {limits.length > 0 && (
        <>
          <div className="my-3 h-px w-full bg-separator-border-strong" />

          <div className="flex items-center justify-between gap-3 py-1">
            <span className="text-body-medium text-text-secondary">
              {text.planUsageLimits}
              {plan ? ` · ${plan}` : ""}
            </span>
            {planHref && (
              <a
                href={planHref}
                aria-label={text.managePlan}
                className="flex size-6 items-center justify-center rounded-md text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-secondary-hover hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <ArrowRight className="size-4" aria-hidden />
              </a>
            )}
          </div>

          <div className="flex flex-col gap-3 pt-1">
            {limits.map((limit) => {
              const pct = Math.round(Math.max(0, Math.min(1, limit.used)) * 100);
              return (
                <div key={limit.label} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body-medium text-text-primary">{limit.label}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="text-body-regular text-text-tertiary">{limit.resets}</span>
                      <span className="w-9 text-right text-body-medium text-text-primary tabular-nums">{pct}%</span>
                    </span>
                  </div>
                  <Bar>
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{ width: `${pct}%`, backgroundColor: "var(--color-chart-6)" }}
                    />
                  </Bar>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
