import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTimelineRenderWeightDiagnosticPayload,
  classifyTimelineVirtualizerStability,
  estimateTimelineProjectionRowSize,
  estimateTimelineProjectionRenderWeight,
  getActiveLiveTimelineRowKeys,
  isTimelineRenderWeightGateEnabled,
  DEFAULT_TIMELINE_VIRTUALIZER_STABILITY_RECOVERY_BUDGET,
  summarizeTimelineProjectionRenderWeight,
  observeTimelineElementOffset,
  resolveTimelineCanvasOverscan,
  resolveTimelineVirtualizerStabilityRecovery,
  resolveVirtualizedTimelineRowPlaceholderHeight,
  resolveVirtualizedTimelineRowVisualHeight,
  resolveVirtualizedTimelineScopeReset,
  shouldVirtualizeTimelineRows,
  TIMELINE_CANVAS_STABLE_OVERSCAN,
  TIMELINE_CANVAS_STREAMING_OVERSCAN,
  TIMELINE_LIGHTWEIGHT_ROW_PLACEHOLDER_HEIGHT,
  TIMELINE_RENDER_WEIGHT_BASELINE_FLAG_KEY,
  TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT,
  TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT,
  TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT,
  TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT,
  TIMELINE_VIRTUALIZATION_MIN_ROWS,
} from "./messagesTimelineVirtualization";
import { createHeavyHistoryFixture } from "./messagesHeavyHistoryFixture.test-support";
import type { TimelineProjectionRow } from "./messagesTimelineProjection";

describe("messagesTimelineVirtualization", () => {
  afterEach(() => {
    globalThis.localStorage.removeItem(TIMELINE_RENDER_WEIGHT_BASELINE_FLAG_KEY);
  });

  it("enables virtualization only for long stable timelines", () => {
    expect(shouldVirtualizeTimelineRows({
      isThinking: false,
      rowCount: TIMELINE_VIRTUALIZATION_MIN_ROWS,
    })).toBe(true);
    expect(shouldVirtualizeTimelineRows({
      isThinking: false,
      rowCount: TIMELINE_VIRTUALIZATION_MIN_ROWS - 1,
    })).toBe(false);
  });

  it("keeps active streaming timelines in static flow to avoid bottom-follow jumps", () => {
    expect(shouldVirtualizeTimelineRows({
      isThinking: true,
      rowCount: 1_000,
    })).toBe(false);
    expect(shouldVirtualizeTimelineRows({
      isThinking: true,
      rowCount: 200,
    })).toBe(false);
    expect(shouldVirtualizeTimelineRows({
      isThinking: true,
      rowCount: 50,
    })).toBe(false);
  });

  it("does not virtualize active streaming timelines by render weight below the row-count threshold", () => {
    expect(shouldVirtualizeTimelineRows({
      isThinking: true,
      rowCount: 12,
      renderWeight: TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT,
    })).toBe(false);
  });

  it("reduces canvas overscan during active heavy streaming", () => {
    expect(resolveTimelineCanvasOverscan({
      isThinking: false,
      isWorking: false,
      rowCount: 24,
      renderWeight: 12,
    })).toBe(TIMELINE_CANVAS_STABLE_OVERSCAN);

    expect(resolveTimelineCanvasOverscan({
      isThinking: true,
      isWorking: false,
      rowCount: TIMELINE_VIRTUALIZATION_MIN_ROWS,
      renderWeight: 12,
    })).toBe(TIMELINE_CANVAS_STREAMING_OVERSCAN);

    expect(resolveTimelineCanvasOverscan({
      isThinking: false,
      isWorking: true,
      rowCount: 12,
      renderWeight: TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT,
    })).toBe(TIMELINE_CANVAS_STREAMING_OVERSCAN);
  });

  it("clamps virtual row placeholder height for invalid and extreme measurements", () => {
    expect(resolveVirtualizedTimelineRowPlaceholderHeight(undefined)).toBe(
      TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT,
    );
    expect(resolveVirtualizedTimelineRowPlaceholderHeight(Number.NaN)).toBe(
      TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT,
    );
    expect(resolveVirtualizedTimelineRowPlaceholderHeight(-10)).toBe(
      TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MIN_HEIGHT,
    );
    expect(resolveVirtualizedTimelineRowPlaceholderHeight(10_000)).toBe(
      TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT,
    );
  });

  it("uses compact visual height for lightweight rows instead of stale heavy measurements", () => {
    expect(resolveVirtualizedTimelineRowVisualHeight({
      measuredSize: TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT,
      estimatedSize: 260,
      lightweight: true,
    })).toBe(TIMELINE_LIGHTWEIGHT_ROW_PLACEHOLDER_HEIGHT);

    expect(resolveVirtualizedTimelineRowVisualHeight({
      measuredSize: TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT,
      estimatedSize: 260,
      lightweight: false,
    })).toBe(TIMELINE_VIRTUAL_ROW_PLACEHOLDER_MAX_HEIGHT);
  });

  it("can restore the baseline eager behavior below the row-count threshold", () => {
    globalThis.localStorage.setItem(TIMELINE_RENDER_WEIGHT_BASELINE_FLAG_KEY, "1");

    expect(shouldVirtualizeTimelineRows({
      isThinking: false,
      rowCount: 12,
      renderWeight: TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT * 4,
    })).toBe(false);
  });

  it("keeps the render-weight gate enabled when storage is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage unavailable");
      },
    });

    try {
      expect(isTimelineRenderWeightGateEnabled()).toBe(true);
      expect(shouldVirtualizeTimelineRows({
        isThinking: false,
        rowCount: 12,
        renderWeight: TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT * 4,
      })).toBe(true);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
    }
  });

  it("estimates grouped rows higher than a single item row", () => {
    const singleRow: TimelineProjectionRow = {
      kind: "entry",
      key: "item:message:1",
      entry: {
        kind: "item",
        item: { id: "message-1", kind: "message", role: "assistant", text: "hello" },
      },
      itemIds: ["message-1"],
      hasActiveUserInputAnchor: false,
    };
    const groupRow: TimelineProjectionRow = {
      kind: "entry",
      key: "readGroup:1:2:2",
      entry: {
        kind: "readGroup",
        items: [
          {
            id: "tool-1",
            kind: "tool",
            toolType: "Read",
            title: "Read",
            detail: "a.ts",
            status: "completed",
          },
          {
            id: "tool-2",
            kind: "tool",
            toolType: "Read",
            title: "Read",
            detail: "b.ts",
            status: "completed",
          },
        ],
      },
      itemIds: ["tool-1", "tool-2"],
      hasActiveUserInputAnchor: false,
    };

    expect(estimateTimelineProjectionRowSize(groupRow)).toBeGreaterThan(
      estimateTimelineProjectionRowSize(singleRow),
    );
  });

  it("assigns high render weight to image-heavy message rows", () => {
    const imageRow: TimelineProjectionRow = {
      kind: "entry",
      key: "item:message:image",
      entry: {
        kind: "item",
        item: {
          id: "message-image",
          kind: "message",
          role: "user",
          text: "screenshot",
          images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
        },
      },
      itemIds: ["message-image"],
      hasActiveUserInputAnchor: false,
    };

    expect(estimateTimelineProjectionRenderWeight(imageRow)).toBeGreaterThan(40);
  });

  it("virtualizes #721-class heavy history even when row count is below the threshold", () => {
    const { rows } = createHeavyHistoryFixture("heavy");
    const summary = summarizeTimelineProjectionRenderWeight(rows);

    expect(summary.rowCount).toBeLessThan(TIMELINE_VIRTUALIZATION_MIN_ROWS);
    expect(summary.renderWeight).toBeGreaterThanOrEqual(TIMELINE_VIRTUALIZATION_MIN_RENDER_WEIGHT);
    expect(summary.categoryCounts.markdownTable).toBeGreaterThan(0);
    expect(summary.categoryCounts.codeFence).toBeGreaterThan(0);
    expect(summary.categoryCounts.toolRawPayload).toBeGreaterThan(0);
    expect(summary.categoryCounts.readBatch).toBeGreaterThan(0);
    expect(summary.categoryCounts.diff).toBeGreaterThan(0);
    expect(shouldVirtualizeTimelineRows({
      isThinking: false,
      rowCount: summary.rowCount,
      renderWeight: summary.renderWeight,
    })).toBe(true);
  });

  it("builds content-safe heavy-history baseline diagnostics", () => {
    const { rows } = createHeavyHistoryFixture("medium");
    const summary = summarizeTimelineProjectionRenderWeight(rows);
    const payload = buildTimelineRenderWeightDiagnosticPayload({
      summary,
      shouldVirtualize: true,
      hydratedHeavyRowCount: 3,
      localErrorState: "none",
      threadId: "thread-1",
      workspaceId: "workspace-1",
    });
    const serializedPayload = JSON.stringify(payload);

    expect(payload).toMatchObject({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      rowCount: summary.rowCount,
      renderWeight: summary.renderWeight,
      heavyRowCount: summary.heavyRowCount,
      hydratedHeavyRowCount: 3,
      localErrorState: "none",
      shouldVirtualize: true,
    });
    expect(serializedPayload).not.toContain("src/fixture");
    expect(serializedPayload).not.toContain("secret.ts");
    expect(serializedPayload).not.toContain("tool_call");
  });

  it("finds active live row keys from item and docked reasoning rows", () => {
    const rows: TimelineProjectionRow[] = [
      {
        kind: "entry",
        key: "item:message:assistant-live",
        entry: {
          kind: "item",
          item: {
            id: "assistant-live",
            kind: "message",
            role: "assistant",
            text: "streaming",
          },
        },
        itemIds: ["assistant-live"],
        hasActiveUserInputAnchor: false,
      },
      {
        kind: "dockedReasoning",
        key: "claude-live:reasoning-live",
        itemId: "reasoning-live",
      },
      { kind: "workingIndicator", key: "working-indicator" },
    ];

    expect(getActiveLiveTimelineRowKeys({
      rows,
      liveAssistantItemId: "assistant-live",
      liveReasoningItemId: "reasoning-live",
    })).toEqual(["item:message:assistant-live", "claude-live:reasoning-live"]);
  });

  it("classifies empty virtualizer output as suspicious only when rows can render", () => {
    expect(classifyTimelineVirtualizerStability({
      shouldVirtualize: true,
      rowCount: 8,
      hasScrollElement: true,
      virtualItemKeys: [],
      activeLiveRowKeys: [],
      streamingActive: false,
    })).toBe("empty-visible-set");

    expect(classifyTimelineVirtualizerStability({
      shouldVirtualize: true,
      rowCount: 8,
      hasScrollElement: false,
      virtualItemKeys: [],
      activeLiveRowKeys: [],
      streamingActive: false,
    })).toBe("stable");
  });

  it("classifies missing active live rows during streaming", () => {
    expect(classifyTimelineVirtualizerStability({
      shouldVirtualize: true,
      rowCount: 8,
      hasScrollElement: true,
      virtualItemKeys: ["item:message:older", "working-indicator"],
      activeLiveRowKeys: ["item:message:assistant-live"],
      streamingActive: true,
    })).toBe("active-live-row-missing");

    expect(classifyTimelineVirtualizerStability({
      shouldVirtualize: true,
      rowCount: 8,
      hasScrollElement: true,
      virtualItemKeys: ["item:message:assistant-live", "working-indicator"],
      activeLiveRowKeys: ["item:message:assistant-live"],
      streamingActive: true,
    })).toBe("stable");
  });

  it("bounds repeated virtualizer stability remeasure recovery by signature", () => {
    let budget = DEFAULT_TIMELINE_VIRTUALIZER_STABILITY_RECOVERY_BUDGET;

    for (let attempt = 0; attempt < TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT; attempt += 1) {
      const recovery = resolveTimelineVirtualizerStabilityRecovery({
        previous: budget,
        signature: "active-live-row-missing:8",
        now: (attempt + 1) * 1_000,
        remeasureCooldownMs: 1,
        diagnosticCooldownMs: 1,
      });
      expect(recovery.shouldRemeasure).toBe(true);
      budget = recovery.nextBudget;
    }

    const suppressedRecovery = resolveTimelineVirtualizerStabilityRecovery({
      previous: budget,
      signature: "active-live-row-missing:8",
      now: 10_000,
      remeasureCooldownMs: 1,
      diagnosticCooldownMs: 1,
    });

    expect(suppressedRecovery.shouldRemeasure).toBe(false);
    expect(suppressedRecovery.remeasureSuppressed).toBe(true);
    expect(suppressedRecovery.nextBudget.remeasureCount).toBe(
      TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT,
    );
  });

  it("resets virtualizer stability recovery budget for a new signature", () => {
    const exhaustedRecovery = resolveTimelineVirtualizerStabilityRecovery({
      previous: {
        signature: "active-live-row-missing:8",
        remeasureCount: TIMELINE_VIRTUALIZER_STABILITY_MAX_REMEASURE_COUNT,
        lastRemeasureAt: 1_000,
        lastDiagnosticAt: 1_000,
      },
      signature: "empty-visible-set:8",
      now: 2_000,
      remeasureCooldownMs: 1,
      diagnosticCooldownMs: 1,
    });

    expect(exhaustedRecovery.shouldRemeasure).toBe(true);
    expect(exhaustedRecovery.nextBudget.remeasureCount).toBe(1);
    expect(exhaustedRecovery.remeasureSuppressed).toBe(false);
  });

  it("measures first stable virtualized history mount without jumping to top", () => {
    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: null,
      nextScopeKey: "ws-1 thread-1 200 120 virtualized",
      shouldVirtualize: true,
      stableHistoryView: true,
      hasPendingJump: false,
      hasScrollElement: true,
    })).toEqual({
      nextScopeKey: "ws-1 thread-1 200 120 virtualized",
      shouldResetScroll: false,
      shouldMeasure: true,
    });
  });

  it("resets stale scroll scope only for a new stable virtualized history thread", () => {
    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: "ws-1\u0000thread-old\u0000200",
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldVirtualize: true,
      stableHistoryView: true,
      hasPendingJump: false,
      hasScrollElement: true,
    })).toEqual({
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldResetScroll: true,
      shouldMeasure: true,
    });

    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: "ws-1\u0000thread-new\u0000200",
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldVirtualize: true,
      stableHistoryView: true,
      hasPendingJump: false,
      hasScrollElement: true,
    })).toEqual({
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldResetScroll: false,
      shouldMeasure: false,
    });
  });

  it("remeasures without resetting scroll when the same history thread changes weight", () => {
    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: "ws-1\u0000thread-1\u0000200\u0000120\u0000virtualized",
      nextScopeKey: "ws-1\u0000thread-1\u0000205\u0000135\u0000virtualized",
      shouldVirtualize: true,
      stableHistoryView: true,
      hasPendingJump: false,
      hasScrollElement: true,
    })).toEqual({
      nextScopeKey: "ws-1\u0000thread-1\u0000205\u0000135\u0000virtualized",
      shouldResetScroll: false,
      shouldMeasure: true,
    });
  });

  it("does not reset virtualized scroll during streaming or jump targeting", () => {
    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: "ws-1\u0000thread-old\u0000200",
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldVirtualize: true,
      stableHistoryView: false,
      hasPendingJump: false,
      hasScrollElement: true,
    }).shouldResetScroll).toBe(false);

    expect(resolveVirtualizedTimelineScopeReset({
      previousScopeKey: "ws-1\u0000thread-old\u0000200",
      nextScopeKey: "ws-1\u0000thread-new\u0000200",
      shouldVirtualize: true,
      stableHistoryView: true,
      hasPendingJump: true,
      hasScrollElement: true,
    }).shouldResetScroll).toBe(false);
  });

  it("clears pending scroll-end fallback when virtualizer unmounts", () => {
    const listeners = new Map<string, EventListener>();
    const element = {
      scrollLeft: 0,
      scrollTop: 240,
      addEventListener: vi.fn((eventName: string, listener: EventListener) => {
        listeners.set(eventName, listener);
      }),
      removeEventListener: vi.fn(),
    } as unknown as Element & { scrollLeft: number; scrollTop: number };
    const setTimeoutSpy = vi.fn(() => 7);
    const clearTimeoutSpy = vi.fn();
    const targetWindow = {
      setTimeout: setTimeoutSpy,
      clearTimeout: clearTimeoutSpy,
    } as unknown as Window & typeof globalThis;
    const instance = {
      scrollElement: element,
      targetWindow,
      options: {
        horizontal: false,
        isRtl: false,
        isScrollingResetDelay: 150,
        useScrollendEvent: false,
      },
    } as Virtualizer<Element, Element>;
    const callback = vi.fn();

    const cleanup = observeTimelineElementOffset(instance, callback);
    listeners.get("scroll")?.(new Event("scroll"));
    cleanup?.();

    expect(callback).toHaveBeenCalledWith(240, true);
    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(7);
  });
});
