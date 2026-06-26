import { describe, expect, it } from "vitest";
import { createHeavyHistoryFixture } from "./messagesHeavyHistoryFixture.test-support";
import {
  countHydratedHeavyTimelineRows,
  deriveTimelineRowHydrationStates,
} from "./messagesTimelineHydration";

describe("messagesTimelineHydration", () => {
  it("derives render-layer hydration state without changing row order", () => {
    const { rows } = createHeavyHistoryFixture("heavy");
    const visibleRowKey = rows[0]?.key ?? "";
    const states = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set([visibleRowKey]),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
    });

    expect(states.map((state) => state.rowKey)).toEqual(rows.map((row) => row.key));
    expect(states.every((state) => state.contentHash.length > 0)).toBe(true);
    expect(states.some((state) => state.heavy && state.mode === "summary")).toBe(true);
  });

  it("hydrates only visible active and anchor heavy rows while virtualized", () => {
    const { rows } = createHeavyHistoryFixture("heavy");
    const heavyCandidateRows = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: false,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
    }).filter((state) => state.heavy);
    const visibleHeavyRowKey = heavyCandidateRows[0]?.rowKey ?? "";
    const activeHeavyRowKey = heavyCandidateRows[1]?.rowKey ?? "";
    const anchorHeavyRowKey = heavyCandidateRows[2]?.rowKey ?? "";

    const states = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set([visibleHeavyRowKey]),
      activeRowKeys: new Set([activeHeavyRowKey]),
      anchorTargetRowKey: anchorHeavyRowKey,
    });
    const hydratedHeavyRows = states.filter((state) => state.heavy && state.mode === "hydrated");

    expect(hydratedHeavyRows.map((state) => state.rowKey).sort()).toEqual(
      [visibleHeavyRowKey, activeHeavyRowKey, anchorHeavyRowKey].sort(),
    );
    expect(countHydratedHeavyTimelineRows(states)).toBe(3);
  });

  it("retains heavy row hydration after it leaves the visible set", () => {
    const { rows } = createHeavyHistoryFixture("heavy");
    const heavyCandidateRows = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: false,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
    }).filter((state) => state.heavy);
    const retainedHeavyRowKey = heavyCandidateRows[0]?.rowKey ?? "";

    const states = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      retainedHydratedRowKeys: new Set([retainedHeavyRowKey]),
      anchorTargetRowKey: null,
    });
    const retainedState = states.find((state) => state.rowKey === retainedHeavyRowKey);

    expect(retainedState?.mode).toBe("hydrated");
    expect(retainedState?.hydrationReason).toBe("visible");
  });

  it("hydrates every heavy row after explicit detail hydration is requested", () => {
    const { rows } = createHeavyHistoryFixture("heavy");
    const states = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
      detailHydrationRequested: true,
    });
    const heavyStates = states.filter((state) => state.heavy);

    expect(heavyStates.length).toBeGreaterThan(0);
    expect(heavyStates.every((state) => state.mode === "hydrated")).toBe(true);
    expect(heavyStates.every((state) => state.hydrationReason === "detail-requested")).toBe(true);
  });

  it("recomputes content hash when row content shape changes", () => {
    const medium = createHeavyHistoryFixture("medium");
    const heavy = createHeavyHistoryFixture("heavy");
    const mediumState = deriveTimelineRowHydrationStates({
      rows: medium.rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
    }).find((state) => state.heavy);
    const heavyState = deriveTimelineRowHydrationStates({
      rows: heavy.rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
    }).find((state) => state.rowKey === mediumState?.rowKey);

    expect(mediumState?.contentHash).toBeTruthy();
    expect(heavyState?.contentHash).toBeTruthy();
    expect(heavyState?.contentHash).not.toBe(mediumState?.contentHash);
  });

  it("includes renderer options in hydration content hash", () => {
    const { rows } = createHeavyHistoryFixture("medium");
    const baseState = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
      rendererOptionsKey: "engine:codex|markdown:codex-canvas",
    }).find((state) => state.heavy);
    const changedOptionsState = deriveTimelineRowHydrationStates({
      rows,
      shouldVirtualize: true,
      visibleRowKeys: new Set(),
      activeRowKeys: new Set(),
      anchorTargetRowKey: null,
      rendererOptionsKey: "engine:claude|markdown:plain",
    }).find((state) => state.rowKey === baseState?.rowKey);

    expect(baseState?.rendererOptionsKey).toBe("engine:codex|markdown:codex-canvas");
    expect(changedOptionsState?.rendererOptionsKey).toBe("engine:claude|markdown:plain");
    expect(changedOptionsState?.contentHash).not.toBe(baseState?.contentHash);
  });
});
