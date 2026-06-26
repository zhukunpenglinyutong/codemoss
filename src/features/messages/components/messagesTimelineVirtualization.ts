import type { Virtualizer } from "@tanstack/react-virtual";
import type { ConversationItem } from "../../../types";
import type { TimelineProjectionRow } from "./messagesTimelineProjection";

export const TIMELINE_VIRTUALIZATION_MIN_ROWS = 200;
export const TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT = 96;
export const TIMELINE_VIRTUALIZATION_HEAVY_ROW_WEIGHT = 16;
export const TIMELINE_CANVAS_STABLE_OVERSCAN = 12;
export const TIMELINE_CANVAS_STREAMING_OVERSCAN = 8;
export const TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT = 1;
export const TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT = 320;
export const TIMELINE_LIGHTWEIGHT_ROW_PLACEHOLDER_HEIGHT = 44;
export const TIMELINE_RENDER_WEIGHT_BASELINE_FLAG_KEY =
  "ccgui.perf.timelineRenderWeightBaseline";
export const TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT = 3;

export type TimelineRenderWeightCategory =
  | "anchorOutlinePressure"
  | "codeFence"
  | "deferredImage"
  | "diff"
  | "generatedImage"
  | "image"
  | "markdownTable"
  | "messageText"
  | "readBatch"
  | "reasoning"
  | "review"
  | "toolOutput"
  | "toolRawPayload";

export type TimelineRenderWeightCategoryCounts = Partial<
  Record<TimelineRenderWeightCategory, number>
>;

export type TimelineRenderWeightSummary = {
  rowCount: number;
  renderWeight: number;
  heavyRowCount: number;
  categoryCounts: TimelineRenderWeightCategoryCounts;
};

/**
 * Keep active streaming timelines in static flow. Live rows change height while
 * auto-follow scrolls to the tail; virtualizer offset correction can otherwise
 * fight bottom-follow and produce rapid up/down jumps in long conversations.
 */
export const TIMELINE_VIRTUALIZATION_DURING_STREAMING_ENABLED = false;

function canReadBaselineFlag() {
  if (typeof globalThis === "undefined") {
    return false;
  }
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

export function isTimelineRenderWeightGateEnabled() {
  if (!canReadBaselineFlag()) {
    return true;
  }
  try {
    const value = globalThis.localStorage.getItem(TIMELINE_RENDER_WEIGHT_BASELINE_FLAG_KEY);
    return value !== "1" && value !== "true" && value !== "on";
  } catch {
    return true;
  }
}

export function shouldVirtualizeTimelineRows(input: {
  isThinking: boolean;
  rowCount: number;
  renderWeight?: number;
}) {
  if (input.isThinking) {
    return TIMELINE_VIRTUALIZATION_DURING_STREAMING_ENABLED &&
      input.rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS;
  }
  const renderWeightGateEnabled = isTimelineRenderWeightGateEnabled();
  const hasHighRenderDensity = renderWeightGateEnabled &&
    typeof input.renderWeight === "number" &&
    input.renderWeight >= TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT &&
    input.renderWeight > input.rowCount * 2;
  if (hasHighRenderDensity) {
    return true;
  }
  return input.rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS;
}

export function resolveTimelineCanvasOverscan(input: {
  isThinking: boolean;
  isWorking: boolean;
  rowCount: number;
  renderWeight: number;
}) {
  if (!input.isThinking && !input.isWorking) {
    return TIMELINE_CANVAS_STABLE_OVERSCAN;
  }
  if (
    input.rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS ||
    input.renderWeight >= TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT
  ) {
    return TIMELINE_CANVAS_STREAMING_OVERSCAN;
  }
  return TIMELINE_CANVAS_STABLE_OVERSCAN;
}

export function resolveVirtualizedTimelineRowPlaceholderHeight(size: unknown) {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT;
  }
  return Math.min(
    TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT,
    Math.max(TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT, Math.ceil(size)),
  );
}

export function resolveVirtualizedTimelineRowVisualHeight(input: {
  measuredSize: unknown;
  estimatedSize: number;
  lightweight: boolean;
}) {
  if (input.lightweight) {
    return TIMELINE_LIGHTWEIGHT_ROW_PLACEHOLDER_HEIGHT;
  }
  return resolveVirtualizedTimelineRowPlaceholderHeight(
    typeof input.measuredSize === "number" && Number.isFinite(input.measuredSize)
      ? input.measuredSize
      : input.estimatedSize,
  );
}

type RenderWeightBreakdown = {
  weight: number;
  categoryCounts: TimelineRenderWeightCategoryCounts;
};

function incrementCategory(
  categoryCounts: TimelineRenderWeightCategoryCounts,
  category: TimelineRenderWeightCategory,
  amount: number,
) {
  if (amount <= 0) {
    return;
  }
  categoryCounts[category] = (categoryCounts[category] ?? 0) + amount;
}

function mergeCategoryCounts(
  target: TimelineRenderWeightCategoryCounts,
  source: TimelineRenderWeightCategoryCounts,
) {
  for (const [category, amount] of Object.entries(source)) {
    incrementCategory(
      target,
      category as TimelineRenderWeightCategory,
      typeof amount === "number" ? amount : 0,
    );
  }
}

function countRegexMatches(input: string, pattern: RegExp, maxCount: number) {
  let count = 0;
  for (const _match of input.matchAll(pattern)) {
    count += 1;
    if (count >= maxCount) {
      break;
    }
  }
  return count;
}

function countMarkdownTableRows(text: string) {
  let tableRows = 0;
  for (const line of text.split(/\r?\n/)) {
    const pipeCount = countRegexMatches(line, /\|/g, 8);
    if (pipeCount >= 2) {
      tableRows += 1;
    }
    if (tableRows >= 160) {
      break;
    }
  }
  return tableRows;
}

function estimateMarkdownTextBreakdown(text: string): RenderWeightBreakdown {
  const categoryCounts: TimelineRenderWeightCategoryCounts = {};
  let weight = Math.min(24, Math.floor(text.length / 2_000));
  incrementCategory(categoryCounts, "messageText", weight);

  const tableRows = countMarkdownTableRows(text);
  if (tableRows > 0) {
    const tableWeight = Math.min(48, tableRows * 2);
    weight += tableWeight;
    incrementCategory(categoryCounts, "markdownTable", tableRows);
  }

  const codeFenceCount = countRegexMatches(text, /(^|\n)(```|~~~)/g, 32);
  if (codeFenceCount > 0) {
    const codeFenceWeight = Math.min(40, codeFenceCount * 6 + Math.floor(text.length / 6_000));
    weight += codeFenceWeight;
    incrementCategory(categoryCounts, "codeFence", codeFenceCount);
  }

  const toolXmlCount = countRegexMatches(
    text,
    /<(?:function_calls?|invoke|tool_call|tool_result|tool_use)\b/gi,
    12,
  );
  if (toolXmlCount > 0) {
    const toolXmlWeight = Math.min(36, toolXmlCount * 12);
    weight += toolXmlWeight;
    incrementCategory(categoryCounts, "toolRawPayload", toolXmlCount);
  }

  return { weight, categoryCounts };
}

function estimateConversationItemRenderWeight(item: ConversationItem): RenderWeightBreakdown {
  const categoryCounts: TimelineRenderWeightCategoryCounts = {};
  if (item.kind === "message") {
    const imageWeight = (item.images ?? []).reduce((total, image) => {
      const inlineDataWeight = image.toLowerCase().startsWith("data:image/")
        ? Math.min(160, Math.ceil(image.length / 32_768))
        : 0;
      return total + 28 + inlineDataWeight;
    }, 0);
    const deferredImageWeight = (item.deferredImages?.length ?? 0) * 18;
    const textBreakdown = estimateMarkdownTextBreakdown(item.text);
    incrementCategory(categoryCounts, "image", item.images?.length ?? 0);
    incrementCategory(categoryCounts, "deferredImage", item.deferredImages?.length ?? 0);
    mergeCategoryCounts(categoryCounts, textBreakdown.categoryCounts);
    return {
      weight: 1 + imageWeight + deferredImageWeight + textBreakdown.weight,
      categoryCounts,
    };
  }
  if (item.kind === "generatedImage") {
    const imageWeight = item.images.reduce((total, image) => {
      const inlineDataWeight = image.src.toLowerCase().startsWith("data:image/")
        ? Math.min(160, Math.ceil(image.src.length / 32_768))
        : 0;
      return total + 28 + inlineDataWeight;
    }, 0);
    incrementCategory(categoryCounts, "generatedImage", item.images.length || 1);
    return { weight: 24 + imageWeight, categoryCounts };
  }
  if (item.kind === "reasoning") {
    const weight = Math.min(18, Math.floor((item.summary.length + item.content.length) / 2_000));
    incrementCategory(categoryCounts, "reasoning", weight);
    return { weight: 1 + weight, categoryCounts };
  }
  if (item.kind === "tool") {
    const outputLength = item.output?.length ?? 0;
    const changeCount = item.changes?.length ?? 0;
    const changeDiffLength =
      item.changes?.reduce((total, change) => total + (change.diff?.length ?? 0), 0) ?? 0;
    const outputWeight = Math.min(32, Math.floor(outputLength / 1_500));
    const changeWeight = Math.min(32, changeCount * 4 + Math.floor(changeDiffLength / 1_500));
    const rawPayloadCount = countRegexMatches(
      `${item.title}\n${item.detail}\n${item.output ?? ""}`,
      /<(?:function_calls?|invoke|tool_call|tool_result|tool_use)\b/gi,
      12,
    );
    const rawPayloadWeight = Math.min(36, rawPayloadCount * 12);
    incrementCategory(categoryCounts, "toolOutput", outputWeight);
    incrementCategory(categoryCounts, "diff", changeCount);
    incrementCategory(categoryCounts, "toolRawPayload", rawPayloadCount);
    return {
      weight: 1 + outputWeight + changeWeight + rawPayloadWeight,
      categoryCounts,
    };
  }
  if (item.kind === "diff" || item.kind === "review") {
    const textLength = item.kind === "diff" ? item.diff.length : item.text.length;
    const diffMarkerCount =
      item.kind === "diff"
        ? countRegexMatches(item.diff, /(^|\n)(diff --git|@@|\+\+\+ |--- )/g, 80)
        : 0;
    const weight = Math.min(40, Math.floor(textLength / 1_500) + diffMarkerCount * 2);
    incrementCategory(categoryCounts, item.kind === "diff" ? "diff" : "review", weight);
    return { weight: 1 + weight, categoryCounts };
  }
  return { weight: 1, categoryCounts };
}

export function estimateTimelineProjectionRenderWeight(row: TimelineProjectionRow) {
  return summarizeTimelineProjectionRowRenderWeight(row).renderWeight;
}

function summarizeTimelineProjectionRowRenderWeight(row: TimelineProjectionRow) {
  if (row.kind !== "entry") {
    return {
      renderWeight: row.kind === "bottomAnchor" ? 0 : 1,
      categoryCounts: {} satisfies TimelineRenderWeightCategoryCounts,
    };
  }
  const categoryCounts: TimelineRenderWeightCategoryCounts = {};
  let renderWeight = 0;
  if (row.entry.kind === "item") {
    const breakdown = estimateConversationItemRenderWeight(row.entry.item);
    renderWeight += breakdown.weight;
    mergeCategoryCounts(categoryCounts, breakdown.categoryCounts);
  } else {
    if (row.entry.kind === "readGroup") {
      const readBatchWeight = Math.min(48, row.entry.items.length * 6);
      renderWeight += readBatchWeight;
      incrementCategory(categoryCounts, "readBatch", row.entry.items.length);
    }
    for (const item of row.entry.items) {
      const breakdown = estimateConversationItemRenderWeight(item);
      renderWeight += breakdown.weight;
      mergeCategoryCounts(categoryCounts, breakdown.categoryCounts);
    }
  }
  if (row.hasActiveUserInputAnchor) {
    renderWeight += 8;
    incrementCategory(categoryCounts, "anchorOutlinePressure", 1);
  }
  return { renderWeight, categoryCounts };
}

export function summarizeTimelineProjectionRenderWeight(
  rows: readonly TimelineProjectionRow[],
): TimelineRenderWeightSummary {
  const categoryCounts: TimelineRenderWeightCategoryCounts = {};
  let renderWeight = 0;
  let heavyRowCount = 0;
  for (const row of rows) {
    const rowSummary = summarizeTimelineProjectionRowRenderWeight(row);
    renderWeight += rowSummary.renderWeight;
    if (rowSummary.renderWeight >= TIMELINE_VIRTUALIZATION_HEAVY_ROW_WEIGHT) {
      heavyRowCount += 1;
    }
    mergeCategoryCounts(categoryCounts, rowSummary.categoryCounts);
  }
  return {
    rowCount: rows.length,
    renderWeight,
    heavyRowCount,
    categoryCounts,
  };
}

export function getTimelineVirtualizationThresholdReason(input: {
  rowCount: number;
  renderWeight: number;
}) {
  if (input.rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS) {
    return "row-count";
  }
  if (
    isTimelineRenderWeightGateEnabled() &&
    input.renderWeight >= TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT &&
    input.renderWeight > input.rowCount * 2
  ) {
    return "render-weight";
  }
  return "disabled";
}

export function buildTimelineRenderWeightDiagnosticPayload(input: {
  summary: TimelineRenderWeightSummary;
  shouldVirtualize: boolean;
  hydratedHeavyRowCount?: number | null;
  localErrorState?: "none" | "contained" | "blocked" | "unknown";
  threadId?: string | null;
  workspaceId?: string | null;
}) {
  const thresholdReason = getTimelineVirtualizationThresholdReason({
    rowCount: input.summary.rowCount,
    renderWeight: input.summary.renderWeight,
  });
  return {
    threadId: input.threadId ?? null,
    workspaceId: input.workspaceId ?? null,
    rowCount: input.summary.rowCount,
    renderWeight: input.summary.renderWeight,
    heavyRowCount: input.summary.heavyRowCount,
    hydratedHeavyRowCount: input.hydratedHeavyRowCount ?? null,
    localErrorState: input.localErrorState ?? "unknown",
    categoryCounts: input.summary.categoryCounts,
    shouldVirtualize: input.shouldVirtualize,
    thresholdReason,
  };
}

export function estimateTimelineProjectionRowSize(row: TimelineProjectionRow) {
  switch (row.kind) {
    case "entry":
      if (row.entry.kind !== "item") {
        if (row.entry.kind === "bashGroup" || row.entry.kind === "readGroup") {
          return 128;
        }
        return 112;
      }
      switch (row.entry.item.kind) {
        case "explore":
          return row.entry.item.status === "exploring" ? 52 : 36;
        case "tool":
          return 58;
        case "reasoning":
          return 72;
        case "message": {
          const textLength = row.entry.item.text.length;
          if (row.entry.item.role === "user") {
            return Math.min(180, 48 + Math.ceil(textLength / 220) * 18);
          }
          return Math.min(260, 72 + Math.ceil(textLength / 320) * 20);
        }
        case "diff":
        case "review":
          return 104;
        case "generatedImage":
          return 180;
        default:
          return 112;
      }
    case "dockedReasoning":
      return 96;
    case "tailUserInput":
      return 132;
    case "liveMiddleCollapsed":
      return 44;
    case "workingIndicator":
      return 52;
    case "emptyState":
      return 160;
    case "approval":
      return 132;
    case "bottomAnchor":
      return 1;
  }
}

export function getActiveLiveTimelineRowKeys(input: {
  rows: readonly TimelineProjectionRow[];
  liveAssistantItemId?: string | null;
  liveReasoningItemId?: string | null;
}) {
  const liveItemIds = new Set(
    [input.liveAssistantItemId, input.liveReasoningItemId].filter(
      (itemId): itemId is string => typeof itemId === "string" && itemId.length > 0,
    ),
  );
  if (liveItemIds.size === 0) {
    return [];
  }
  return input.rows
    .filter((row) => {
      if (row.kind === "entry") {
        return row.itemIds.some((itemId) => liveItemIds.has(itemId));
      }
      if (row.kind === "dockedReasoning") {
        return liveItemIds.has(row.itemId);
      }
      return false;
    })
    .map((row) => row.key);
}

export type TimelineVirtualizerStabilityState =
  | "stable"
  | "empty-visible-set"
  | "active-live-row-missing";

export type TimelineVirtualizerStabilityRecoveryBudget = {
  signature: string;
  remeasureCount: number;
  lastRemeasureAt: number;
  lastDiagnosticAt: number;
};

export const DEFAULT_TIMELINE_VIRTUALIZER_STABILITY_RECOVERY_BUDGET: TimelineVirtualizerStabilityRecoveryBudget = {
  signature: "",
  remeasureCount: 0,
  lastRemeasureAt: 0,
  lastDiagnosticAt: 0,
};

export function classifyTimelineVirtualizerStability(input: {
  shouldVirtualize: boolean;
  rowCount: number;
  hasScrollElement: boolean;
  virtualItemKeys: ReadonlyArray<unknown>;
  activeLiveRowKeys: readonly string[];
  streamingActive: boolean;
}): TimelineVirtualizerStabilityState {
  if (!input.shouldVirtualize || !input.hasScrollElement || input.rowCount <= 0) {
    return "stable";
  }
  if (input.virtualItemKeys.length === 0) {
    return "empty-visible-set";
  }
  if (!input.streamingActive || input.activeLiveRowKeys.length === 0) {
    return "stable";
  }
  const visibleKeys = new Set(input.virtualItemKeys.map(String));
  return input.activeLiveRowKeys.some((rowKey) => !visibleKeys.has(rowKey))
    ? "active-live-row-missing"
    : "stable";
}

export function resolveTimelineVirtualizerStabilityRecovery(input: {
  previous: TimelineVirtualizerStabilityRecoveryBudget;
  signature: string;
  now: number;
  remeasureCooldownMs: number;
  diagnosticCooldownMs: number;
  maxRemeasureCount?: number;
}) {
  const maxRemeasureCount =
    input.maxRemeasureCount ?? TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT;
  const previous =
    input.previous.signature === input.signature
      ? input.previous
      : DEFAULT_TIMELINE_VIRTUALIZER_STABILITY_RECOVERY_BUDGET;
  const canRemeasureByCooldown =
    input.now - previous.lastRemeasureAt >= input.remeasureCooldownMs;
  const shouldRemeasure =
    previous.remeasureCount < maxRemeasureCount && canRemeasureByCooldown;
  const shouldDiagnose =
    input.now - previous.lastDiagnosticAt >= input.diagnosticCooldownMs;
  const nextBudget: TimelineVirtualizerStabilityRecoveryBudget = {
    signature: input.signature,
    remeasureCount: shouldRemeasure
      ? previous.remeasureCount + 1
      : previous.remeasureCount,
    lastRemeasureAt: shouldRemeasure
      ? input.now
      : previous.lastRemeasureAt,
    lastDiagnosticAt: shouldDiagnose
      ? input.now
      : previous.lastDiagnosticAt,
  };
  return {
    nextBudget,
    shouldRemeasure,
    shouldDiagnose,
    remeasureSuppressed: nextBudget.remeasureCount >= maxRemeasureCount,
  };
}

export function resolveVirtualizedTimelineScopeReset(input: {
  previousScopeKey: string | null;
  nextScopeKey: string;
  shouldVirtualize: boolean;
  stableHistoryView: boolean;
  hasPendingJump: boolean;
  hasScrollElement: boolean;
}) {
  if (!input.shouldVirtualize) {
    return {
      nextScopeKey: null,
      shouldResetScroll: false,
      shouldMeasure: false,
    };
  }
  if (!input.stableHistoryView || input.hasPendingJump || !input.hasScrollElement) {
    return {
      nextScopeKey: input.previousScopeKey,
      shouldResetScroll: false,
      shouldMeasure: false,
    };
  }
  if (input.previousScopeKey === null) {
    return {
      nextScopeKey: input.nextScopeKey,
      shouldResetScroll: false,
      shouldMeasure: true,
    };
  }
  if (
    resolveVirtualizedTimelineScopeIdentity(input.previousScopeKey) ===
    resolveVirtualizedTimelineScopeIdentity(input.nextScopeKey)
  ) {
    return {
      nextScopeKey: input.nextScopeKey,
      shouldResetScroll: false,
      shouldMeasure: input.previousScopeKey !== input.nextScopeKey,
    };
  }
  return {
    nextScopeKey: input.nextScopeKey,
    shouldResetScroll: true,
    shouldMeasure: true,
  };
}

function resolveVirtualizedTimelineScopeIdentity(scopeKey: string): string {
  const [workspaceId = "", threadId = ""] = scopeKey.split("\u0000");
  return [workspaceId, threadId].join("\u0000");
}

export function observeTimelineElementOffset<TScrollElement extends Element>(
  instance: Virtualizer<TScrollElement, Element>,
  callback: (offset: number, isScrolling: boolean) => void,
) {
  const element = instance.scrollElement;
  const targetWindow = instance.targetWindow;
  if (!element || !targetWindow) {
    return;
  }

  let offset = 0;
  let timeoutId: number | null = null;
  const clearPendingScrollEnd = () => {
    if (timeoutId !== null) {
      targetWindow.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const supportsScrollEnd = "onscrollend" in targetWindow;
  const useScrollEndEvent = instance.options.useScrollendEvent && supportsScrollEnd;

  const scheduleScrollEndFallback = () => {
    if (useScrollEndEvent) {
      return;
    }
    clearPendingScrollEnd();
    timeoutId = targetWindow.setTimeout(() => {
      timeoutId = null;
      callback(offset, false);
    }, instance.options.isScrollingResetDelay);
  };

  const createHandler = (isScrolling: boolean) => () => {
    offset = instance.options.horizontal
      ? element.scrollLeft * (instance.options.isRtl ? -1 : 1)
      : element.scrollTop;
    scheduleScrollEndFallback();
    callback(offset, isScrolling);
  };
  const scrollHandler = createHandler(true);
  const scrollEndHandler = createHandler(false);
  element.addEventListener("scroll", scrollHandler, { passive: true });
  if (useScrollEndEvent) {
    element.addEventListener("scrollend", scrollEndHandler, { passive: true });
  }
  return () => {
    clearPendingScrollEnd();
    element.removeEventListener("scroll", scrollHandler);
    if (useScrollEndEvent) {
      element.removeEventListener("scrollend", scrollEndHandler);
    }
  };
}
