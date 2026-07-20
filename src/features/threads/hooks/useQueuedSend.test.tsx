// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../types";
import { useQueuedSend } from "./useQueuedSend";

const workspace: WorkspaceInfo = {
  id: "workspace-1",
  name: "ccgui",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const makeOptions = (
  overrides: Partial<Parameters<typeof useQueuedSend>[0]> = {},
) => ({
  activeThreadId: "thread-1",
  activeTurnId: undefined,
  activeContinuationPulse: 0,
  activeTerminalPulse: 0,
  isProcessing: false,
  isReviewing: false,
  steerEnabled: false,
  activeWorkspace: workspace,
  resolveCanonicalThreadId: (threadId: string) => threadId,
  connectWorkspace: vi.fn().mockResolvedValue(undefined),
  startThreadForWorkspace: vi.fn().mockResolvedValue("thread-1"),
  sendUserMessage: vi.fn().mockResolvedValue(undefined),
  sendUserMessageToThread: vi.fn().mockResolvedValue(undefined),
  startFork: vi.fn().mockResolvedValue(undefined),
  startReview: vi.fn().mockResolvedValue(undefined),
  startResume: vi.fn().mockResolvedValue(undefined),
  startMcp: vi.fn().mockResolvedValue(undefined),
  startSpecRoot: vi.fn().mockResolvedValue(undefined),
  startStatus: vi.fn().mockResolvedValue(undefined),
  startContext: vi.fn().mockResolvedValue(undefined),
  startExport: vi.fn().mockResolvedValue(undefined),
  startImport: vi.fn().mockResolvedValue(undefined),
  startLsp: vi.fn().mockResolvedValue(undefined),
  startShare: vi.fn().mockResolvedValue(undefined),
  startCompact: vi.fn().mockResolvedValue(undefined),
  startFast: vi.fn().mockResolvedValue(undefined),
  startMode: vi.fn().mockResolvedValue(undefined),
  setCodexCollaborationMode: vi.fn(),
  getCodexCollaborationPayload: vi.fn().mockReturnValue(null),
  interruptTurn: vi.fn().mockResolvedValue(undefined),
  handleFusionStalled: vi.fn(),
  clearActiveImages: vi.fn(),
  ...overrides,
});

describe("useQueuedSend", () => {
  it("sends queued messages one at a time after processing completes", async () => {
    const options = makeOptions();
    const { result, rerender } = renderHook(
      (props) => useQueuedSend(props),
      { initialProps: options },
    );

    await act(async () => {
      await result.current.queueMessage("First");
      await result.current.queueMessage("Second");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("First", []);

    await act(async () => {
      rerender({ ...options, isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(options.sendUserMessage).toHaveBeenLastCalledWith("Second", []);
  });

  it("holds the queue while an AskUserQuestion is pending, then flushes once it clears", async () => {
    const options = makeOptions({ hasPendingUserInput: true });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Queued during ask");
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Turn is blocked on the dialog answer — must NOT dispatch the queued message.
    expect(options.sendUserMessage).not.toHaveBeenCalled();

    // Dialog answered → pending clears → queue drains.
    await act(async () => {
      rerender({ ...options, hasPendingUserInput: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("Queued during ask", []);
  });

  it("waits for processing to start before sending the next queued message", async () => {
    const options = makeOptions();
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Alpha");
      await result.current.queueMessage("Beta");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("Alpha", []);
  });

  it("creates a visible codex handoff bubble and sends queued follow-up directly to the active thread", async () => {
    const options = makeOptions({
      activeEngine: "codex",
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
      sendUserMessageToThread: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Follow-up question", ["local://img-1"], {
        selectedAgent: {
          id: "agent-1",
          name: "排障助手",
          icon: "agent-robot-02",
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.sendUserMessageToThread).toHaveBeenCalledWith(
      workspace,
      "thread-1",
      "Follow-up question",
      ["local://img-1"],
      expect.objectContaining({
        selectedAgent: expect.objectContaining({
          id: "agent-1",
          name: "排障助手",
        }),
      }),
    );
    expect(result.current.activeQueuedHandoffBubble).toMatchObject({
      id: expect.stringMatching(/^queued-handoff-/),
      kind: "message",
      role: "user",
      text: "Follow-up question",
      images: ["local://img-1"],
      selectedAgentName: "排障助手",
    });
  });

  it("makes the next queued codex follow-up visible before the current turn completes", async () => {
    const options = makeOptions({
      activeEngine: "codex",
      isProcessing: true,
      steerEnabled: false,
      activeItems: [
        {
          id: "assistant-current-turn",
          kind: "message",
          role: "assistant",
          text: "上一轮仍在生成。",
        },
      ],
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("第二条排队消息");
    });

    expect(result.current.activeQueue).toHaveLength(1);
    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem).toBeDefined();
    expect(result.current.activeQueuedHandoffBubble).toMatchObject({
      id: expect.stringMatching(/^queued-handoff-/),
      kind: "message",
      role: "user",
      text: "第二条排队消息",
      anchorItemId: "assistant-current-turn",
    });

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessageToThread).toHaveBeenCalledWith(
      workspace,
      "thread-1",
      "第二条排队消息",
      [],
      expect.objectContaining({
        eagerOptimisticUserId: `optimistic-user-queued-${queuedItem!.id}`,
        skipOptimisticUserBubble: true,
      }),
    );
  });

  it("promotes a third queued codex follow-up after the prior handoff becomes canonical", async () => {
    const options = makeOptions({
      activeEngine: "codex",
      isProcessing: true,
      steerEnabled: false,
      activeItems: [
        {
          id: "assistant-first-turn",
          kind: "message",
          role: "assistant",
          text: "第一轮仍在生成。",
        },
      ],
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("第二条排队消息");
    });
    const secondQueuedItem = result.current.activeQueue[0];
    expect(secondQueuedItem).toBeDefined();

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      rerender({
        ...options,
        isProcessing: true,
        activeItems: [
          {
            id: "assistant-first-turn",
            kind: "message",
            role: "assistant",
            text: "第一轮已完成。",
          },
          {
            id: `optimistic-user-queued-${secondQueuedItem!.id}`,
            kind: "message",
            role: "user",
            text: "第二条排队消息",
          },
          {
            id: "assistant-second-turn",
            kind: "message",
            role: "assistant",
            text: "第二轮正在生成。",
          },
        ],
      });
    });

    await act(async () => {
      await result.current.handleSend("第三条排队消息");
    });

    expect(result.current.activeQueue.map((item) => item.text)).toEqual([
      "第三条排队消息",
    ]);
    expect(result.current.activeQueuedHandoffBubble).toMatchObject({
      id: expect.stringMatching(/^queued-handoff-/),
      text: "第三条排队消息",
      anchorItemId: "assistant-second-turn",
    });
  });

  it("removes the visible handoff bubble when its queued message is removed", async () => {
    const options = makeOptions({
      activeEngine: "codex",
      isProcessing: true,
      steerEnabled: false,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("删除前的排队消息");
    });

    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem).toBeDefined();
    expect(result.current.activeQueuedHandoffBubble).not.toBeNull();

    act(() => {
      result.current.removeQueuedMessage("thread-1", queuedItem!.id);
    });

    expect(result.current.activeQueue).toEqual([]);
    expect(result.current.activeQueuedHandoffBubble).toBeNull();
  });

  it("queues send while processing when steer is disabled", async () => {
    const options = makeOptions({ isProcessing: true, steerEnabled: false });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("Queued");
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(result.current.activeQueue).toHaveLength(1);
    expect(result.current.activeQueue[0]?.text).toBe("Queued");
  });

  it("sends immediately while processing when steer is enabled", async () => {
    const options = makeOptions({ isProcessing: true, steerEnabled: true });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("Steer");
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("Steer", []);
    expect(result.current.activeQueue).toHaveLength(0);
  });

  it("queues while processing on claude pending thread even when steer is enabled", async () => {
    const options = makeOptions({
      activeEngine: "claude",
      activeThreadId: "claude-pending-1700000000000-abc123",
      isProcessing: true,
      steerEnabled: true,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("Queue until session id is ready");
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(result.current.activeQueue).toHaveLength(1);
    expect(result.current.activeQueue[0]?.text).toBe("Queue until session id is ready");
  });

  it("does not allow queue fusion while claude thread is still pending", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "claude",
      activeThreadId: "claude-pending-1700000000000-def456",
      isProcessing: true,
      steerEnabled: true,
      interruptTurn,
      sendUserMessage,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse later");
    });

    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem).toBeTruthy();
    expect(result.current.canFuseActiveQueue).toBe(false);

    await act(async () => {
      await result.current.fuseQueuedMessage(
        "claude-pending-1700000000000-def456",
        queuedItem!.id,
      );
    });

    expect(interruptTurn).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(result.current.activeQueue).toHaveLength(1);
    expect(result.current.activeFusingMessageId).toBeNull();
  });

  it("migrates queued claude pending messages to finalized session thread id", async () => {
    const options = makeOptions({
      activeEngine: "claude",
      activeThreadId: "claude-pending-1700000000000-rename1",
      isProcessing: true,
      steerEnabled: true,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("pending queue item");
    });

    expect(result.current.activeQueue.map((item) => item.text)).toEqual([
      "pending queue item",
    ]);

    await act(async () => {
      rerender({
        ...options,
        activeThreadId: "claude:session-rename-1",
        isProcessing: true,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeQueue.map((item) => item.text)).toEqual([
      "pending queue item",
    ]);

    await act(async () => {
      rerender({
        ...options,
        activeThreadId: "claude:session-rename-1",
        isProcessing: false,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("pending queue item", []);
  });

  it("migrates queued codex pending messages when the alias confirms the rebind", async () => {
    const pendingThreadId = "codex-pending-1700000000000-alias1";
    const realThreadId = "0198f3a2-real-codex-thread";
    const options = makeOptions({
      activeEngine: "codex",
      activeThreadId: pendingThreadId,
      isProcessing: true,
      steerEnabled: true,
      resolveCanonicalThreadId: (threadId: string) =>
        threadId === pendingThreadId ? realThreadId : threadId,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("pending codex item");
    });

    await act(async () => {
      rerender({ ...options, activeThreadId: realThreadId, isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ ...options, activeThreadId: realThreadId, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessageToThread).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessageToThread).toHaveBeenCalledWith(
      workspace,
      realThreadId,
      "pending codex item",
      [],
      expect.objectContaining({
        eagerOptimisticUserId: expect.stringMatching(/^optimistic-user-queued-/),
        skipOptimisticUserBubble: true,
      }),
    );
  });

  it("does not migrate codex pending queue when switching to an unrelated codex thread", async () => {
    const pendingThreadId = "codex-pending-1700000000000-alias2";
    const options = makeOptions({
      activeEngine: "codex",
      activeThreadId: pendingThreadId,
      isProcessing: true,
      steerEnabled: true,
      // No alias recorded: the pending thread was never finalized to this id.
      resolveCanonicalThreadId: (threadId: string) => threadId,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("stays on pending thread");
    });

    await act(async () => {
      rerender({
        ...options,
        activeThreadId: "0198f3a2-unrelated-codex-thread",
        isProcessing: false,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.sendUserMessageToThread).not.toHaveBeenCalled();
    expect(result.current.activeQueue).toHaveLength(0);
    expect(
      result.current.queuedByThread[pendingThreadId]?.map((item) => item.text),
    ).toEqual(["stays on pending thread"]);
  });

  it("retries queued send after failure", async () => {
    const options = makeOptions({
      sendUserMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined),
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Retry");
    });

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(options.sendUserMessage).toHaveBeenLastCalledWith("Retry", []);
  });

  it("queues messages per thread and only flushes the active thread", async () => {
    const options = makeOptions({ isProcessing: true });
    const { result, rerender } = renderHook(
      (props) => useQueuedSend(props),
      { initialProps: options },
    );

    await act(async () => {
      await result.current.queueMessage("Thread-1");
    });

    await act(async () => {
      rerender({ ...options, activeThreadId: "thread-2", isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ ...options, activeThreadId: "thread-1", isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("Thread-1", []);
  });

  it("connects workspace before sending when disconnected", async () => {
    const connectWorkspace = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeWorkspace: { ...workspace, connected: false },
      connectWorkspace,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("Connect");
    });

    expect(connectWorkspace).toHaveBeenCalledWith({
      ...workspace,
      connected: false,
    });
    expect(options.sendUserMessage).toHaveBeenCalledWith("Connect", []);
  });

  it("ignores images for queued review messages and blocks while reviewing", async () => {
    const options = makeOptions();
    const { result, rerender } = renderHook(
      (props) => useQueuedSend(props),
      { initialProps: options },
    );

    await act(async () => {
      await result.current.queueMessage("/review check this", ["img-1"]);
      await result.current.queueMessage("After review");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.startReview).toHaveBeenCalledTimes(1);
    expect(options.startReview).toHaveBeenCalledWith("/review check this");
    expect(options.sendUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ ...options, isReviewing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ ...options, isReviewing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("After review", []);
  });

  it("keeps /review-code as plain text and does not route to review handler", async () => {
    const options = makeOptions();
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/review-code run full check", ["img-1"]);
    });

    expect(options.startReview).not.toHaveBeenCalled();
    expect(options.sendUserMessage).toHaveBeenCalledWith(
      "/review-code run full check",
      ["img-1"],
    );
  });

  it("keeps /review-like custom commands as plain text", async () => {
    const options = makeOptions();
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });
    const cases = [
      "/review:custom run",
      "/review_custom run",
      "/review.custom run",
    ];

    await act(async () => {
      for (const text of cases) {
        await result.current.handleSend(text, ["img-1"]);
      }
    });

    expect(options.startReview).not.toHaveBeenCalled();
    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      1,
      "/review:custom run",
      ["img-1"],
    );
    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      2,
      "/review_custom run",
      ["img-1"],
    );
    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      3,
      "/review.custom run",
      ["img-1"],
    );
  });

  it("starts a new thread for /new and sends the remaining text there", async () => {
    const startThreadForWorkspace = vi.fn().mockResolvedValue("thread-2");
    const sendUserMessageToThread = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startThreadForWorkspace, sendUserMessageToThread });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/new hello there", ["img-1"]);
    });

    expect(startThreadForWorkspace).toHaveBeenCalledWith("workspace-1", {
      engine: "claude",
    });
    expect(sendUserMessageToThread).toHaveBeenCalledWith(
      workspace,
      "thread-2",
      "hello there",
      [],
    );
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("starts a new thread for bare /new without sending a message", async () => {
    const startThreadForWorkspace = vi.fn().mockResolvedValue("thread-3");
    const sendUserMessageToThread = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startThreadForWorkspace, sendUserMessageToThread });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/new");
    });

    expect(startThreadForWorkspace).toHaveBeenCalledWith("workspace-1", {
      engine: "claude",
    });
    expect(sendUserMessageToThread).not.toHaveBeenCalled();
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("treats /clear and /reset as new-session aliases on claude", async () => {
    const startThreadForWorkspace = vi
      .fn()
      .mockResolvedValueOnce("thread-4")
      .mockResolvedValueOnce("thread-5");
    const sendUserMessageToThread = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "claude",
      startThreadForWorkspace,
      sendUserMessageToThread,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/clear keep this", ["img-1"]);
      await result.current.handleSend("/reset");
    });

    expect(startThreadForWorkspace).toHaveBeenNthCalledWith(1, "workspace-1", {
      engine: "claude",
    });
    expect(startThreadForWorkspace).toHaveBeenNthCalledWith(2, "workspace-1", {
      engine: "claude",
    });
    expect(sendUserMessageToThread).toHaveBeenCalledWith(
      workspace,
      "thread-4",
      "keep this",
      [],
    );
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /status to the local status handler", async () => {
    const startStatus = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startStatus });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/status now", ["img-1"]);
    });

    expect(startStatus).toHaveBeenCalledWith("/status now");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.startReview).not.toHaveBeenCalled();
  });

  it("switches to plan mode and sends remaining text for codex /plan", async () => {
    const setCodexCollaborationMode = vi.fn();
    const options = makeOptions({
      activeEngine: "codex",
      setCodexCollaborationMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/plan 请先分析");
    });

    expect(setCodexCollaborationMode).toHaveBeenCalledWith("plan");
    expect(options.sendUserMessage).toHaveBeenCalledWith(
      "请先分析",
      [],
      expect.objectContaining({
        collaborationMode: expect.objectContaining({
          mode: "plan",
        }),
      }),
    );
  });

  it("switches to default mode for codex /default and /code alias", async () => {
    const setCodexCollaborationMode = vi.fn();
    const options = makeOptions({
      activeEngine: "codex",
      setCodexCollaborationMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/default");
      await result.current.handleSend("/code");
    });

    expect(setCodexCollaborationMode).toHaveBeenNthCalledWith(1, "code");
    expect(setCodexCollaborationMode).toHaveBeenNthCalledWith(2, "code");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /context to the local context handler", async () => {
    const startContext = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startContext });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/context", ["img-1"]);
    });

    expect(startContext).toHaveBeenCalledWith("/context");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /mode to local mode handler in codex", async () => {
    const startMode = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      startMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/mode");
    });

    expect(startMode).toHaveBeenCalledWith("/mode");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /fast as codex command and strips images", async () => {
    const startFast = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      startFast,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/fast on", ["img-1"]);
    });

    expect(startFast).toHaveBeenCalledWith("/fast on");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("sends /goal text through the normal message path", async () => {
    const options = makeOptions({
      activeEngine: "codex",
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/goal Ship the migration", ["img-1"]);
    });

    expect(options.sendUserMessage).toHaveBeenCalled();
    expect(vi.mocked(options.sendUserMessage).mock.calls[0]?.[0]).toBe(
      "/goal Ship the migration",
    );
    expect(vi.mocked(options.sendUserMessage).mock.calls[0]?.[1]).toEqual(["img-1"]);
  });

  it("routes /compact as claude command and strips images", async () => {
    const startCompact = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "claude",
      startCompact,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/compact", ["img-1"]);
    });

    expect(startCompact).toHaveBeenCalledWith("/compact");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes implicit current-mode question to local mode handler in codex", async () => {
    const startMode = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      startMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("现在是什么模式 是计划模式吗");
    });

    expect(startMode).toHaveBeenCalledWith("现在是什么模式 是计划模式吗");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not treat mode-difference question as implicit mode query", async () => {
    const startMode = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      startMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("计划模式和default模式区别多大");
    });

    expect(startMode).not.toHaveBeenCalled();
    expect(options.sendUserMessage).toHaveBeenCalledWith(
      "计划模式和default模式区别多大",
      [],
    );
  });

  it("treats codex-only slash commands as plain text on non-codex engines", async () => {
    const startMode = vi.fn().mockResolvedValue(undefined);
    const setCodexCollaborationMode = vi.fn();
    const options = makeOptions({
      activeEngine: "claude",
      startMode,
      setCodexCollaborationMode,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/plan keep text", ["img-1"]);
      await result.current.handleSend("/mode", ["img-2"]);
      await result.current.handleSend("/fast on", ["img-3"]);
    });

    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      1,
      "/plan keep text",
      ["img-1"],
    );
    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      2,
      "/mode",
      ["img-2"],
    );
    expect(options.sendUserMessage).toHaveBeenNthCalledWith(
      3,
      "/fast on",
      ["img-3"],
    );
    expect(startMode).not.toHaveBeenCalled();
    expect(setCodexCollaborationMode).not.toHaveBeenCalled();
  });

  it("keeps /compact as plain text on non-claude engines", async () => {
    const startCompact = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      startCompact,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/compact", ["img-1"]);
    });

    expect(startCompact).not.toHaveBeenCalled();
    expect(options.sendUserMessage).toHaveBeenCalledWith("/compact", ["img-1"]);
  });

  it("routes /compact by claude thread ownership even when active engine is stale", async () => {
    const startCompact = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeEngine: "codex",
      activeThreadId: "claude:session-1",
      startCompact,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/compact", ["img-1"]);
    });

    expect(startCompact).toHaveBeenCalledWith("/compact");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps /clear as plain text on codex engine", async () => {
    const options = makeOptions({
      activeEngine: "codex",
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/clear");
    });

    expect(options.sendUserMessage).toHaveBeenCalledWith("/clear", []);
    expect(options.startThreadForWorkspace).not.toHaveBeenCalled();
  });

  it("routes /spec-root to the spec root handler", async () => {
    const startSpecRoot = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startSpecRoot });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/spec-root rebind", ["img-1"]);
    });

    expect(startSpecRoot).toHaveBeenCalledWith("/spec-root rebind");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /mcp to the MCP handler", async () => {
    const startMcp = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startMcp });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/mcp now", ["img-1"]);
    });

    expect(startMcp).toHaveBeenCalledWith("/mcp now");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.startReview).not.toHaveBeenCalled();
  });

  it("routes /export to the export handler", async () => {
    const startExport = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startExport });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/export now", ["img-1"]);
    });

    expect(startExport).toHaveBeenCalledWith("/export now");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /share to the share handler", async () => {
    const startShare = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startShare });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/share now", ["img-1"]);
    });

    expect(startShare).toHaveBeenCalledWith("/share now");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /import to the import handler", async () => {
    const startImport = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startImport });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/import ~/Downloads/a.json", ["img-1"]);
    });

    expect(startImport).toHaveBeenCalledWith("/import ~/Downloads/a.json");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /lsp to the lsp handler", async () => {
    const startLsp = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startLsp });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/lsp symbols useThread", ["img-1"]);
    });

    expect(startLsp).toHaveBeenCalledWith("/lsp symbols useThread");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
  });

  it("routes /resume to the resume handler", async () => {
    const startResume = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startResume });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/resume now", ["img-1"]);
    });

    expect(startResume).toHaveBeenCalledWith("/resume now");
    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.startReview).not.toHaveBeenCalled();
  });

  it("routes /fork to the fork handler", async () => {
    const startFork = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startFork });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/fork branch here", ["img-1"]);
    });

    expect(startFork).toHaveBeenCalledWith("/fork branch here", undefined);
    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(options.startReview).not.toHaveBeenCalled();
  });

  it("passes send options through /fork so the fork first message keeps composer settings", async () => {
    const startFork = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({ startFork });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("/fork branch here", [], {
        model: "claude-opus-4-1",
        effort: "high",
      });
    });

    expect(startFork).toHaveBeenCalledWith("/fork branch here", {
      model: "claude-opus-4-1",
      effort: "high",
    });
  });

  it("does not send when reviewing even if steer is enabled", async () => {
    const options = makeOptions({ isReviewing: true, steerEnabled: true });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.handleSend("Blocked");
    });

    expect(options.sendUserMessage).not.toHaveBeenCalled();
    expect(result.current.activeQueue).toHaveLength(0);
  });

  it("preserves images for queued messages", async () => {
    const options = makeOptions();
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Images", ["img-1", "img-2"]);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenCalledWith("Images", [
      "img-1",
      "img-2",
    ]);
  });

  it("fuses queued message into the active run without interrupting when steer is enabled", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: true,
      interruptTurn,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse now", ["img-1"], {
        selectedMemoryIds: ["memory-1"],
      });
    });

    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", queuedItem!.id);
    });

    expect(interruptTurn).not.toHaveBeenCalled();
    expect(options.sendUserMessage).toHaveBeenCalledWith(
      "Fuse now",
      ["img-1"],
      { selectedMemoryIds: ["memory-1"] },
    );
    expect(result.current.activeQueue).toHaveLength(0);
    expect(result.current.activeFusingMessageId).toBe(queuedItem!.id);
    expect(result.current.canFuseActiveQueue).toBe(false);

    await act(async () => {
      rerender({ ...options, activeContinuationPulse: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
  });

  it("keeps later queued items fusible during consecutive same-run fusions", async () => {
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: true,
      interruptTurn: vi.fn().mockResolvedValue(undefined),
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Fuse second");
      await result.current.queueMessage("Fuse third");
    });

    const firstFusionId = result.current.activeQueue[0]?.id;
    expect(firstFusionId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", firstFusionId!);
    });

    expect(result.current.activeFusingMessageId).toBe(firstFusionId);
    expect(result.current.canFuseActiveQueue).toBe(false);

    await act(async () => {
      rerender({ ...options, activeContinuationPulse: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(result.current.canFuseActiveQueue).toBe(true);

    const secondFusionId = result.current.activeQueue[0]?.id;
    expect(secondFusionId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", secondFusionId!);
    });

    expect(result.current.activeFusingMessageId).toBe(secondFusionId);
    expect(result.current.canFuseActiveQueue).toBe(false);

    await act(async () => {
      rerender({ ...options, activeContinuationPulse: 2 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(result.current.canFuseActiveQueue).toBe(true);
    expect(result.current.activeQueue[0]?.text).toBe("Fuse third");
  });

  it("settles same-run fusion as stalled when no continuation evidence arrives", async () => {
    vi.useFakeTimers();
    const handleFusionStalled = vi.fn();
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: true,
      sendUserMessage,
      handleFusionStalled,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Drain after stall");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    expect(result.current.activeFusingMessageId).toBe(fuseTargetId);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_500);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).toHaveBeenCalledWith("thread-1");
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "Fuse first", []);

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Drain after stall", []);
    vi.useRealTimers();
  });

  it("clears unresolved fusion as soon as terminal settlement arrives", async () => {
    const handleFusionStalled = vi.fn();
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: true,
      sendUserMessage,
      handleFusionStalled,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Drain after error");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    expect(result.current.activeFusingMessageId).toBe(fuseTargetId);

    await act(async () => {
      rerender({
        ...options,
        isProcessing: false,
        activeTerminalPulse: 1,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "Fuse first", []);
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Drain after error", []);
  });

  it("ignores late same-run continuation evidence after the fusion already stalled", async () => {
    vi.useFakeTimers();
    const handleFusionStalled = vi.fn();
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: true,
      handleFusionStalled,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_500);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ ...options, activeContinuationPulse: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("falls back to safe cutover fusion and waits for the next run boundary", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse via cutover", ["img-1"], {
        selectedMemoryIds: ["memory-1"],
      });
    });

    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", queuedItem!.id);
    });

    expect(interruptTurn).toHaveBeenCalledTimes(1);
    expect(interruptTurn).toHaveBeenCalledWith({ reason: "queue-fusion" });
    expect(sendUserMessage).toHaveBeenCalledWith(
      "Fuse via cutover",
      ["img-1"],
      expect.objectContaining({
        selectedMemoryIds: ["memory-1"],
        resumeSource: "queue-fusion-cutover",
        resumeTurnId: "turn-1",
      }),
    );
    expect(interruptTurn.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(result.current.activeFusingMessageId).toBe(queuedItem!.id);

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBe(queuedItem!.id);

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-2", isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
  });

  it("releases cutover fusion immediately when a terminal settlement arrives", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      activeTerminalPulse: 0,
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse via cutover");
      await result.current.queueMessage("Drain after runtime ended");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    expect(result.current.activeFusingMessageId).toBe(fuseTargetId);

    await act(async () => {
      rerender({
        ...options,
        isProcessing: false,
        activeTerminalPulse: 1,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(sendUserMessage).toHaveBeenNthCalledWith(
      2,
      "Drain after runtime ended",
      [],
    );
  });

  it("refuses to fuse queued slash commands", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("/clear");
    });

    const queuedItem = result.current.activeQueue[0];
    expect(queuedItem?.text).toBe("/clear");

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", queuedItem!.id);
    });

    expect(interruptTurn).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(result.current.activeFusingMessageId).toBeNull();
    expect(result.current.activeQueue[0]?.text).toBe("/clear");
  });

  it("restores the original queue index when fusion dispatch fails", async () => {
    const sendUserMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const options = makeOptions({
      isProcessing: true,
      steerEnabled: false,
      sendUserMessage,
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Alpha");
      await result.current.queueMessage("Beta");
      await result.current.queueMessage("Gamma");
    });

    const targetMessageId = result.current.activeQueue[1]?.id;
    expect(targetMessageId).toBeTruthy();

    await expect(
      act(async () => {
        await result.current.fuseQueuedMessage("thread-1", targetMessageId!);
      }),
    ).rejects.toThrow("boom");

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(result.current.activeQueue.map((entry) => entry.text)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("pauses same-thread auto-drain while fusion is unresolved", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Drain later");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(options.sendUserMessage).toHaveBeenLastCalledWith(
      "Fuse first",
      [],
      expect.objectContaining({
        resumeSource: "queue-fusion-cutover",
        resumeTurnId: "turn-1",
      }),
    );
    expect(result.current.activeQueue.map((entry) => entry.text)).toEqual([
      "Drain later",
    ]);

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(result.current.activeFusingMessageId).toBe(fuseTargetId);

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-2", isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-2", isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(options.sendUserMessage).toHaveBeenLastCalledWith("Drain later", []);
    expect(result.current.activeFusingMessageId).toBeNull();
  });

  it("clears an unresolved fusion lock after stop and resumes queue draining", async () => {
    vi.useFakeTimers();
    const handleFusionStalled = vi.fn();
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
      handleFusionStalled,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Drain after stop");
    });

    const fuseTargetId = result.current.activeQueue[0]?.id;
    expect(fuseTargetId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", fuseTargetId!);
    });

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBe(fuseTargetId);
    expect(result.current.canFuseActiveQueue).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_500);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).toHaveBeenCalledWith("thread-1");
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenNthCalledWith(
      1,
      "Fuse first",
      [],
      expect.objectContaining({
        resumeSource: "queue-fusion-cutover",
        resumeTurnId: "turn-1",
      }),
    );
    expect(sendUserMessage).toHaveBeenNthCalledWith(
      2,
      "Drain after stop",
      [],
    );
    vi.useRealTimers();
  });

  it("allows a second fusion after the previous one was cleared by stop", async () => {
    vi.useFakeTimers();
    const handleFusionStalled = vi.fn();
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
      handleFusionStalled,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Second run");
      await result.current.queueMessage("Fuse again");
    });

    const firstFusionId = result.current.activeQueue[0]?.id;
    expect(firstFusionId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", firstFusionId!);
    });

    await act(async () => {
      rerender({ ...options, isProcessing: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_500);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();
    expect(handleFusionStalled).toHaveBeenCalledWith("thread-1");
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Second run", []);

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-2", isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });

    const secondFusionId = result.current.activeQueue[0]?.id;
    expect(secondFusionId).toBeTruthy();
    expect(result.current.canFuseActiveQueue).toBe(true);

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", secondFusionId!);
    });

    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(sendUserMessage).toHaveBeenNthCalledWith(
      3,
      "Fuse again",
      [],
      expect.objectContaining({
        resumeSource: "queue-fusion-cutover",
        resumeTurnId: "turn-2",
      }),
    );
    expect(result.current.activeFusingMessageId).toBe(secondFusionId);
    vi.useRealTimers();
  });

  it("keeps later queued items fusible after a second cutover fusion starts", async () => {
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions({
      activeTurnId: "turn-1",
      isProcessing: true,
      steerEnabled: false,
      interruptTurn,
      sendUserMessage,
    });
    const { result, rerender } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Fuse first");
      await result.current.queueMessage("Fuse second");
      await result.current.queueMessage("Fuse third");
    });

    const firstFusionId = result.current.activeQueue[0]?.id;
    expect(firstFusionId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", firstFusionId!);
    });

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-2", isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();

    const secondFusionId = result.current.activeQueue[0]?.id;
    expect(secondFusionId).toBeTruthy();

    await act(async () => {
      await result.current.fuseQueuedMessage("thread-1", secondFusionId!);
    });

    await act(async () => {
      rerender({ ...options, activeTurnId: "turn-3", isProcessing: true });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeFusingMessageId).toBeNull();

    expect(result.current.canFuseActiveQueue).toBe(true);
    expect(result.current.activeQueue[0]?.text).toBe("Fuse third");
  });

  it("releases stalled in-flight queue item for opencode only", async () => {
    vi.useFakeTimers();
    const options = makeOptions({
      activeEngine: "opencode",
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook((props) => useQueuedSend(props), {
      initialProps: options,
    });

    await act(async () => {
      await result.current.queueMessage("Hello");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(options.sendUserMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(18_500);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.sendUserMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
