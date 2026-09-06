import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import Brain from "lucide-react/dist/esm/icons/brain";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { Message } from "@/lib/ipc";
import type { SessionState } from "../store";
import { parseUsage } from "../usage";
import { cx } from "@/utils/cx";
import { SOFT_EASE } from "@/components/application/agent-log/agent-log";
import { StepRow, type TaskListStep } from "@/components/application/task-list/task-list";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { useThrottled } from "@/hooks/use-throttled";
import { useCopied } from "@/hooks/use-copied";
import { MessageImages } from "./MessageImages";

/** Distance from the scroll tail within which the user counts as "at bottom". */
const BOTTOM_THRESHOLD_PX = 100;

/** Classify a tool-call label (tool name or shell command) into a type chip. */
function toolTypeKey(text: string): string {
  const tokens = text.toLowerCase().split(/[^a-z_]+/).filter(Boolean);
  const has = (...names: string[]) => tokens.some((tok) => names.includes(tok));
  if (has("web_search", "websearch", "web", "fetch", "browse")) return "toolTypeWeb";
  if (has("bash", "sh", "shell", "zsh", "terminal", "run_command")) return "toolTypeShell";
  if (has("read", "cat", "view", "read_file", "open_file")) return "toolTypeRead";
  if (has("write", "edit", "write_file", "edit_file", "apply_patch", "patch", "sed")) return "toolTypeEdit";
  if (has("grep", "glob", "rg", "find", "ls", "search", "search_files")) return "toolTypeSearch";
  if (has("task", "agent", "spawn")) return "toolTypeTask";
  // Multi-word labels are shell commands surfaced by engines like codex.
  if (tokens.length > 1 || text.includes(" ")) return "toolTypeShell";
  return "toolTypeTool";
}

type ProcessItem = { type: "tool" | "thinking"; text: string; live?: boolean };

type TimelineRow =
  | { kind: "msg"; message: Message; turnFinal: boolean }
  | { kind: "process"; items: ProcessItem[]; firstSeq: number };

/** Row wrapper caches keyed by message reference. The store grows rows
 * immutably (spread-copy on change), so a message whose reference survived a
 * stream flush reuses its wrapper and memoized row views skip it entirely.
 * WeakMaps keep no message alive beyond the session state that holds it. */
type MsgRow = Extract<TimelineRow, { kind: "msg" }>;
const msgRowCache = new WeakMap<Message, { final?: MsgRow; plain?: MsgRow }>();
const processItemCache = new WeakMap<Message, ProcessItem>();
const processRowCache = new WeakMap<
  Message,
  { items: ProcessItem[]; row: Extract<TimelineRow, { kind: "process" }> }
>();

function getMsgRow(message: Message, turnFinal: boolean): MsgRow {
  let slots = msgRowCache.get(message);
  if (!slots) {
    slots = {};
    msgRowCache.set(message, slots);
  }
  const cached = turnFinal ? slots.final : slots.plain;
  if (cached) return cached;
  const row: MsgRow = { kind: "msg", message, turnFinal };
  if (turnFinal) slots.final = row;
  else slots.plain = row;
  return row;
}

function getProcessItem(message: Message): ProcessItem {
  let item = processItemCache.get(message);
  if (!item) {
    item = {
      type: message.role === "tool" ? "tool" : "thinking",
      text: message.text,
      live: message.live,
    };
    processItemCache.set(message, item);
  }
  return item;
}

function getProcessRow(first: Message, items: ProcessItem[]): TimelineRow {
  const cached = processRowCache.get(first);
  // Items only ever append (or swap identity wholesale on settle), so an
  // element-wise reference check is a cheap, exact staleness test.
  if (
    cached &&
    cached.items.length === items.length &&
    cached.items.every((item, i) => item === items[i])
  ) {
    return cached.row;
  }
  const row: TimelineRow = { kind: "process", items, firstSeq: first.seq };
  processRowCache.set(first, { items, row });
  return row;
}

/** Fold runs of consecutive tool / thinking messages into single process
 * rows, preserving order — between two chat bubbles there is at most one
 * collapsed chip, never an alternating stack. Row objects are cached per
 * message reference, so rows unaffected by a flush keep their identity and
 * React.memo bails out on them. */
function buildRows(messages: Message[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === "tool" || message.role === "thinking") {
      const first = message;
      const items: ProcessItem[] = [];
      while (
        i < messages.length &&
        (messages[i].role === "tool" || messages[i].role === "thinking")
      ) {
        items.push(getProcessItem(messages[i]));
        i++;
      }
      rows.push(getProcessRow(first, items));
    } else {
      rows.push(getMsgRow(message, false));
      i++;
    }
  }
  // Footer (copy + meta) renders only on a reply's final assistant segment:
  // walk backwards, resetting at each user message. turnFinal variants are
  // cached too — a flip swaps in the other cached wrapper, no mutation.
  let seenAssistant = false;
  for (let j = rows.length - 1; j >= 0; j--) {
    const row = rows[j];
    if (row.kind !== "msg") continue;
    if (row.message.role === "user") {
      seenAssistant = false;
    } else {
      const turnFinal = !seenAssistant;
      seenAssistant = true;
      if (row.turnFinal !== turnFinal) rows[j] = getMsgRow(row.message, turnFinal);
    }
  }
  return rows;
}

function rowKey(row: TimelineRow): string | number {
  return row.kind === "msg" ? row.message.seq : `process-${row.firstSeq}`;
}

function toolEntranceKey(processId: number, index: number): string {
  return `${processId}:${index}`;
}

function collectToolKeys(rows: TimelineRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.kind !== "process") continue;
    row.items.forEach((item, index) => {
      if (item.type === "tool") keys.push(toolEntranceKey(row.firstSeq, index));
    });
  }
  return keys;
}

function markToolKeys(seen: Set<string>, processId: number, items: ProcessItem[]) {
  items.forEach((item, index) => {
    if (item.type === "tool") seen.add(toolEntranceKey(processId, index));
  });
}

type ProcessSection =
  | { type: "thinking"; text: string; live?: boolean }
  | { type: "tools"; calls: { text: string; index: number }[] };

function groupProcessSections(items: ProcessItem[]): ProcessSection[] {
  const sections: ProcessSection[] = [];
  items.forEach((item, index) => {
    if (item.type === "thinking") {
      sections.push({ type: "thinking", text: item.text, live: item.live });
    } else {
      const last = sections[sections.length - 1];
      const call = { text: item.text, index };
      if (last?.type === "tools") last.calls.push(call);
      else sections.push({ type: "tools", calls: [call] });
    }
  });
  return sections;
}

/** Freeze LogRow's `reduce` on first paint so a later parent render cannot
 * flip it mid-entrance (initial only runs on mount). */
function FrozenStepRow({
  play,
  step,
  first,
  last,
}: {
  play: boolean;
  step: TaskListStep;
  first: boolean;
  last: boolean;
}) {
  const reduceRef = useRef(!play);
  return (
    <StepRow
      step={step}
      active={false}
      first={first}
      last={last}
      reduce={reduceRef.current}
    />
  );
}

const TimelineRowView = memo(function TimelineRowView({
  row,
  workspacePath,
  turnLive,
  autoExpand,
  seenRef,
}: {
  row: TimelineRow;
  workspacePath: string;
  /** True while the current turn is still streaming; suppresses the footer. */
  turnLive: boolean;
  /** True on the timeline's last process row: it rides open until a newer
   * one appears, and stays open once the turn settles. */
  autoExpand: boolean;
  seenRef: { current: Set<string> };
}) {
  // Every process run — thinking, tools, or both — folds into the same
  // collapsed summary line ("思考 N 次 工具调用 M 次 >"); expanding shows
  // the per-step details.
  if (row.kind === "process") {
    return (
      <ProcessDisclosure
        items={row.items}
        autoExpand={autoExpand}
        turnLive={turnLive}
        processId={row.firstSeq}
        seenRef={seenRef}
      />
    );
  }
  return (
    <MessageRow
      message={row.message}
      workspacePath={workspacePath}
      turnFinal={row.turnFinal && !turnLive}
    />
  );
});

const LazyMarkdown = lazy(() => import("./Markdown"));

/** Markdown body; the react-markdown/highlight stack loads in a lazy chunk. */
function Markdown({ text, workspacePath }: { text: string; workspacePath: string }) {
  return (
    <Suspense
      fallback={
        <div className="prose-chat text-body-regular whitespace-pre-wrap text-text-primary">
          {text}
        </div>
      }
    >
      <LazyMarkdown text={text} workspacePath={workspacePath} />
    </Suspense>
  );
}

/** Format a message timestamp: HH:mm today, MM-dd HH:mm this year, full date
 * beyond. ts is RFC3339 (claude/pi) or epoch millis as a string (kimi/dsh). */
function formatMessageTime(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const ms = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear())
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** Compact token usage for one message: "↑3.2k ↓412". */
function formatUsage(usage: unknown): string | null {
  const u = parseUsage(usage);
  if (!u || (!u.input && !u.output)) return null;
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
  const parts: string[] = [];
  if (u.input) parts.push(`↑${fmt(u.input)}`);
  if (u.output) parts.push(`↓${fmt(u.output)}`);
  return parts.join(" ");
}

/** Passive per-message facts, revealed on message hover: time · token usage · model. */
function MessageMeta({ message }: { message: Message }) {
  const parts = [
    formatMessageTime(message.ts),
    formatUsage(message.usage),
    message.model || null,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  return (
    <span className="text-caption-1-regular tabular-nums text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      {parts.join(" · ")}
    </span>
  );
}

/** Assistant message hover actions (copy). */
function MessageActions({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  const iconBtn =
    "flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary";
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <button
        type="button"
        aria-label={t("chat.copy")}
        onClick={() => copy(text)}
        className={iconBtn}
      >
        {copied ? (
          <Check className="size-3.5 text-lime-500" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

/** Thinking body: brain header + left-railed gray content, mirroring the
 * reference chat UI. Plain pre-wrapped text — never markdown-reparsed per
 * delta; the live view is windowed to the last 2000 chars. */
function ThinkingSurface({
  text,
  title,
  live,
}: {
  text: string;
  title?: string;
  live?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {title && (
        <div className="flex items-center gap-1.5 text-body-regular text-text-tertiary">
          <Brain className="size-3.5" aria-hidden />
          <span>{title}</span>
        </div>
      )}
      <div className="ml-2 whitespace-pre-wrap break-words border-l border-foreground-icon-quaternary pl-4 text-[12px] leading-[1.65] text-text-tertiary">
        {live ? text.slice(-2000) : text}
      </div>
    </div>
  );
}

/** A run of middle steps (thinking + tool calls) between chat bubbles: one
 * collapsed summary line ("思考 N 次 工具调用 M 次 >").
 * Expanding shows every step in order — thinking as railed sections, tool
 * sub-runs as tree rows. The wrapper stays mounted and collapses by height so
 * AnimatePresence cannot swallow each StepRow's blur-in; historical bodies
 * unmount while collapsed so the virtualizer does not keep every SVG tree. */
const ProcessDisclosure = memo(function ProcessDisclosure({
  items,
  autoExpand = false,
  turnLive = false,
  processId,
  seenRef,
}: {
  items: ProcessItem[];
  autoExpand?: boolean;
  /** True while the turn is still streaming: nothing folds away mid-turn —
   * the reader may be watching a row grow. Older rows fold when the turn
   * settles instead. */
  turnLive?: boolean;
  processId: number;
  seenRef: { current: Set<string> };
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(autoExpand);
  // Once the user clicks the header, their choice wins over the auto
  // expand/collapse driven by newer rows appearing below.
  const overriddenRef = useRef(false);
  const prevAutoRef = useRef(autoExpand);
  const prevLiveRef = useRef(turnLive);
  useEffect(() => {
    const prevAuto = prevAutoRef.current;
    prevAutoRef.current = autoExpand;
    const prevLive = prevLiveRef.current;
    prevLiveRef.current = turnLive;
    if (autoExpand && autoExpand !== prevAuto) {
      // Became the latest row: open it and hand control back to automation.
      overriddenRef.current = false;
      setExpanded(true);
      return;
    }
    if (autoExpand || turnLive) return;
    const superseded = autoExpand !== prevAuto;
    const turnJustSettled = prevLive && !turnLive;
    if ((superseded || turnJustSettled) && !overriddenRef.current) {
      setExpanded(false);
    }
  }, [autoExpand, turnLive]);
  const reduceMotion = useReducedMotion() ?? false;
  // Mark after paint, not at animation complete: a virtualizer remount
  // mid-entrance must skip the replay. New keys still play on this first
  // paint because the set is read before this effect runs.
  useLayoutEffect(() => {
    markToolKeys(seenRef.current, processId, items);
  }, [items, processId, seenRef]);
  const thinkingCount = items.filter((item) => item.type === "thinking").length;
  const toolCount = items.length - thinkingCount;
  // A lone thinking block skips the "思考 1 次" summary: the header is the
  // "思考过程" title itself, and the expanded body drops the inner repeat.
  const singleThinking = items.length === 1 && items[0].type === "thinking";
  const label =
    singleThinking
      ? t("chat.thinkingProcess")
      : thinkingCount > 0 && toolCount > 0
      ? t("chat.processSummary", { thinking: thinkingCount, tools: toolCount })
      : thinkingCount > 0
        ? t("chat.thinkingCount", { count: thinkingCount })
        : t("chat.toolCalls", { count: toolCount });
  // Regrouping per render walks every item; items are reference-stable
  // between flushes (see buildRows caches), so memo on identity.
  const sections = useMemo(() => groupProcessSections(items), [items]);
  const showBody = expanded || turnLive;
  return (
    <div className="mb-1.5 flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          overriddenRef.current = true;
          setExpanded((v) => !v);
        }}
        className="flex w-full cursor-pointer flex-col text-left"
      >
        <span className="flex items-center gap-1 py-0.5 text-body-regular text-text-tertiary transition-colors hover:text-text-secondary">
          {singleThinking && <Brain className="size-3.5" aria-hidden />}
          {label}
          <ChevronRight
            className={cx("size-3.5 transition-transform duration-200", expanded && "rotate-90")}
            aria-hidden
          />
        </span>
      </button>
      {/* Height-animate in place rather than through AnimatePresence: a presence
          context with initial={false} silently cancels each StepRow's blur-in.
          initial={false} here only pins THIS element's first paint, so a
          virtualized remount of an already-open row does not flash shut. */}
      <motion.div
        initial={false}
        animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : {
                height: { duration: 0.3, ease: SOFT_EASE },
                opacity: { duration: 0.22, ease: "easeOut" },
              }
        }
        className="overflow-hidden"
        aria-hidden={!expanded}
      >
        {showBody ? (
          <div className="mt-2 flex flex-col gap-3">
            {sections.map((section, i) =>
              section.type === "thinking" ? (
                <ThinkingSurface key={i} text={section.text} title={singleThinking ? undefined : t("chat.thinkingProcess")} live={section.live} />
              ) : (
                <ul key={i} className="ml-2 flex flex-col">
                  {section.calls.map((call, j) => {
                    const play =
                      expanded &&
                      !reduceMotion &&
                      !seenRef.current.has(toolEntranceKey(processId, call.index));
                    return (
                      <FrozenStepRow
                        key={call.index}
                        play={play}
                        step={{ label: call.text, chips: [{ label: t(`chat.${toolTypeKey(call.text)}`) }] }}
                        first={j === 0}
                        last={j === section.calls.length - 1}
                      />
                    );
                  })}
                </ul>
              ),
            )}
          </div>
        ) : null}
      </motion.div>
    </div>
  );
});

const MessageRow = memo(function MessageRow({
  message,
  workspacePath,
  turnFinal,
}: {
  message: Message;
  workspacePath: string;
  turnFinal: boolean;
}) {
  // A live row's text grows per store flush; a full markdown reparse per
  // flush scales linearly with reply length (~30ms at 32KB) and starves the
  // main thread, so the parse is throttled. Settled rows never change and
  // render as-is.
  const text = useThrottled(message.text, message.live ? 120 : 0);
  if (message.role === "user") {
    return (
      <div className="-mr-1.5 ml-auto flex w-fit max-w-[85%] flex-col rounded-xl bg-bubble-user px-3.5 py-2.5 text-left text-body-regular whitespace-pre-wrap break-words text-text-white">
        {message.images && message.images.length > 0 && (
          <MessageImages images={message.images} />
        )}
        {message.text}
      </div>
    );
  }
  return (
    <div className="group flex flex-col text-left">
      <Markdown text={text} workspacePath={workspacePath} />
      {turnFinal && (
        <div className="mt-1 flex items-center gap-2">
          <MessageActions text={message.text} />
          <MessageMeta message={message} />
        </div>
      )}
    </div>
  );
});

export const MessageTimeline = memo(function MessageTimeline({
  session,
  streaming,
  onLoadEarlier,
  workspacePath,
}: {
  session: SessionState;
  streaming: boolean;
  onLoadEarlier: () => void;
  workspacePath: string;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const items = session.messages;
  const rows = useMemo(() => buildRows(items), [items]);
  // Per-timeline, not a module singleton: ChatConversation remounts this
  // with key={sessionKey}, so a tab switch gets a fresh set. Prime from
  // the first snapshot that already has rows so history / tab-open does
  // not replay height 0→auto. Do not lock an empty set — loading failure
  // and load-earlier both flip `session.loading`, and an empty new chat
  // must still animate the first live tools.
  const seenToolRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  if (!primedRef.current && rows.length > 0) {
    for (const key of collectToolKeys(rows)) seenToolRef.current.add(key);
    primedRef.current = true;
  }
  // Key of the last process row — the one that stays expanded by default.
  const lastProcessKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "process") return rowKey(rows[i]);
    }
    return null;
  }, [rows]);
  // Live stream rows are ordinary rows that grow in place; the only extra
  // tail item is the turn-status indicator below them.
  // The tail indicator stays mounted AND visible for the whole turn — a
  // constant status anchor below the growing rows. Hiding it while content
  // grew made every idle ↔ growing transition read as disconnect/reconnect:
  // the status line kept popping in and out at each tool call and pause.
  // The reply footer (copy + time + usage) only makes sense once the turn
  // settles: while streaming, mid-turn segments (kimi multi-message replies)
  // are not the final word.
  const turnLive = streaming;
  const count = rows.length + (streaming ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) =>
      index < rows.length ? rowKey(rows[index]) : "streaming-tail",
  });

  // --- Stick-to-bottom intent model (ported from the reference chat UI) ---
  // Sampling geometry at content-change time misfires in a virtualized
  // list: a freshly mounted tool row still has the 72px estimated height,
  // so scrollHeight is stale and a "near bottom" check reads wrong. Track
  // user intent instead: wheel-up pauses following, scrolling back down to
  // the bottom resumes it; programmatic scrolls are tagged and ignored.
  const atBottomRef = useRef(true);
  const userPausedRef = useRef(false);
  const autoScrollingRef = useRef(false);

  const isFollowing = useCallback(
    () => atBottomRef.current && !userPausedRef.current,
    [],
  );

  // Pin by scrollTop, not scrollToIndex: index alignment recomputes offsets
  // from the virtualizer's measured sizes, so rows whose height is still
  // settling (live growth, tool rows measuring in) made the viewport jump.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight - el.clientHeight;
    requestAnimationFrame(() => {
      autoScrollingRef.current = false;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight;

    let scrollRaf = 0;
    const handleScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        // Programmatic pins must not read as user intent; an explicit
        // wheel-up pause is cleared only by the wheel handler, otherwise a
        // scroll event from that same gesture (still within the threshold)
        // would immediately un-pause.
        if (autoScrollingRef.current || userPausedRef.current) return;
        atBottomRef.current = distanceFromBottom() < BOTTOM_THRESHOLD_PX;
      });
    };

    // Wheel deltas are always user-initiated: up pauses following, down to
    // the bottom resumes it.
    let wheelRaf = 0;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userPausedRef.current = true;
        atBottomRef.current = false;
      } else if (e.deltaY > 0) {
        if (wheelRaf) cancelAnimationFrame(wheelRaf);
        wheelRaf = requestAnimationFrame(() => {
          wheelRaf = 0;
          if (distanceFromBottom() < BOTTOM_THRESHOLD_PX) {
            userPausedRef.current = false;
            atBottomRef.current = true;
          }
        });
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleWheel);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (wheelRaf) cancelAnimationFrame(wheelRaf);
    };
  }, []);

  // Scroll to bottom when switching sessions (new page loaded) or when a new
  // message is appended while following the tail.
  const lastCountRef = useRef(0);
  useEffect(() => {
    if (!scrollRef.current || count === 0) return;
    const grew = count > lastCountRef.current;
    const switched = lastCountRef.current === 0;
    if (switched || (grew && isFollowing())) scrollToBottom();
    lastCountRef.current = count;
  }, [count, isFollowing, scrollToBottom]);

  // Keep the tail pinned while stream rows grow, if the user is at bottom.
  // `items` changes identity on every flush, so this tracks both thinking
  // and text growth.
  useEffect(() => {
    if (!scrollRef.current || !streaming || !isFollowing()) return;
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [items, streaming, count, isFollowing, scrollToBottom]);

  // Rows re-measure after mount (tool calls render taller than the 72px
  // estimate); each measurement grows the virtual total height after the
  // count/items effects above already ran. Follow those late size changes
  // so the tail stays pinned while tools appear.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.querySelector<HTMLElement>("[data-virtual-inner]");
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (isFollowing()) scrollToBottom();
      });
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isFollowing, scrollToBottom]);

  // Top sentinel: load earlier pages, preserving the first visible item.
  // Refs hold the latest rows/handler so the observer effect does not need
  // to re-subscribe per flush. The render-time writes are the standard
  // "latest ref" pattern: the only readers are observer/rAF callbacks that
  // fire after commit, never render itself.
  const loadingRef = useRef(false);
  const itemsRef = useRef(rows);
  itemsRef.current = rows;
  const onLoadEarlierRef = useRef(onLoadEarlier);
  onLoadEarlierRef.current = onLoadEarlier;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sentinel = el.querySelector<HTMLDivElement>("[data-sentinel]");
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || loadingRef.current || !session.nextBefore) return;
        loadingRef.current = true;
        const firstVisible = virtualizer.getVirtualItems()[1]?.index ?? 0;
        const anchorSeq =
          firstVisible < itemsRef.current.length
            ? rowKey(itemsRef.current[firstVisible])
            : undefined;
        onLoadEarlierRef.current();
        // Restore anchor after prepend: find the same seq in the new list.
        requestAnimationFrame(() => {
          // Read the freshest rows via the ref; the store update lands
          // before this frame.
          const idx = anchorSeq
            ? itemsRef.current.findIndex((r) => rowKey(r) === anchorSeq)
            : -1;
          if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "start" });
          loadingRef.current = false;
        });
      },
      { root: el, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [session.nextBefore, items.length, virtualizer]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4">
      <div data-sentinel className="h-px" />
      {session.nextBefore && (
        <button
          type="button"
          onClick={onLoadEarlier}
          className="mx-auto my-2 block rounded-full bg-background-tertiary-default px-3 py-1 text-caption-1-medium text-text-secondary hover:bg-background-secondary-hover"
        >
          {t("chat.loadEarlier")}
        </button>
      )}
      <div
        data-virtual-inner
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        className="mx-auto max-w-[750px]"
      >
        {virtualizer.getVirtualItems().map((item) => {
          const isTail = item.index >= rows.length;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
              className="py-2"
            >
              {isTail ? (
                <AgentThinking
                  variant="wave"
                  label={t("chat.thinking")}
                  className="py-2"
                  startedAt={session.turnStartedAt ?? undefined}
                />
              ) : (
                <TimelineRowView
                  row={rows[item.index]}
                  workspacePath={workspacePath}
                  turnLive={turnLive}
                  autoExpand={rowKey(rows[item.index]) === lastProcessKey}
                  seenRef={seenToolRef}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
