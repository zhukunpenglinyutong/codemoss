import type { ConversationItem } from "../../../types";
import type { TimelineProjectionRow } from "./messagesTimelineProjection";
import {
  estimateTimelineProjectionRenderWeight,
  TIMELINE_VIRTUALIZATION_HEAVY_ROW_WEIGHT,
} from "./messagesTimelineVirtualization";

export type TimelineRowHydrationMode = "static" | "summary" | "hydrated";

export type TimelineRowHydrationState = {
  rowKey: string;
  contentHash: string;
  rendererOptionsKey: string;
  renderWeight: number;
  heavy: boolean;
  mode: TimelineRowHydrationMode;
  hydrationReason: "not-heavy" | "not-virtualized" | "detail-requested" | "visible" | "active" | "anchor" | "deferred";
};

function stableHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function getItemSignature(item: ConversationItem) {
  switch (item.kind) {
    case "message":
      return [
        item.id,
        item.kind,
        item.role,
        item.text.length,
        item.images?.length ?? 0,
        item.deferredImages?.length ?? 0,
        item.isFinal === true ? "final" : "live",
      ].join(":");
    case "reasoning":
      return [item.id, item.kind, item.summary.length, item.content.length].join(":");
    case "diff":
      return [item.id, item.kind, item.diff.length, item.status ?? ""].join(":");
    case "review":
      return [item.id, item.kind, item.state, item.text.length].join(":");
    case "generatedImage":
      return [item.id, item.kind, item.status, item.images.length].join(":");
    case "tool":
      return [
        item.id,
        item.kind,
        item.toolType,
        item.status ?? "",
        item.detail.length,
        item.output?.length ?? 0,
        item.changes?.length ?? 0,
      ].join(":");
    case "explore":
      return [item.id, item.kind, item.status, item.entries.length].join(":");
  }
}

function getRowContentHash(row: TimelineProjectionRow, rendererOptionsKey: string) {
  if (row.kind !== "entry") {
    return stableHash(`${rendererOptionsKey}:${row.key}:${row.kind}`);
  }
  const itemSignatures =
    row.entry.kind === "item"
      ? [getItemSignature(row.entry.item)]
      : row.entry.items.map(getItemSignature);
  return stableHash([
    rendererOptionsKey,
    row.key,
    row.entry.kind,
    row.hasActiveUserInputAnchor ? "anchor" : "",
    ...itemSignatures,
  ].join("|"));
}

export function deriveTimelineRowHydrationStates(input: {
  rows: readonly TimelineProjectionRow[];
  shouldVirtualize: boolean;
  visibleRowKeys: ReadonlySet<string>;
  activeRowKeys: ReadonlySet<string>;
  retainedHydratedRowKeys?: ReadonlySet<string>;
  anchorTargetRowKey?: string | null;
  detailHydrationRequested?: boolean;
  heavyRowWeight?: number;
  rendererOptionsKey?: string | null;
}): TimelineRowHydrationState[] {
  const heavyRowWeight =
    input.heavyRowWeight ?? TIMELINE_VIRTUALIZATION_HEAVY_ROW_WEIGHT;
  const rendererOptionsKey = input.rendererOptionsKey ?? "default";
  return input.rows.map((row) => {
    const renderWeight = estimateTimelineProjectionRenderWeight(row);
    const heavy = renderWeight >= heavyRowWeight;
    if (!heavy) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "static",
        hydrationReason: "not-heavy",
      };
    }
    if (!input.shouldVirtualize) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "hydrated",
        hydrationReason: "not-virtualized",
      };
    }
    if (input.detailHydrationRequested) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "hydrated",
        hydrationReason: "detail-requested",
      };
    }
    if (input.activeRowKeys.has(row.key)) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "hydrated",
        hydrationReason: "active",
      };
    }
    if (input.anchorTargetRowKey === row.key) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "hydrated",
        hydrationReason: "anchor",
      };
    }
    if (input.visibleRowKeys.has(row.key) || input.retainedHydratedRowKeys?.has(row.key)) {
      return {
        rowKey: row.key,
        contentHash: getRowContentHash(row, rendererOptionsKey),
        rendererOptionsKey,
        renderWeight,
        heavy,
        mode: "hydrated",
        hydrationReason: "visible",
      };
    }
    return {
      rowKey: row.key,
      contentHash: getRowContentHash(row, rendererOptionsKey),
      rendererOptionsKey,
      renderWeight,
      heavy,
      mode: "summary",
      hydrationReason: "deferred",
    };
  });
}

export function countHydratedHeavyTimelineRows(
  states: readonly TimelineRowHydrationState[],
) {
  return states.filter((state) => state.heavy && state.mode === "hydrated").length;
}
