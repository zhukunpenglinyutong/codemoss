// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, MessageSendOptions, WorkspaceInfo } from "../../../types";
import {
  engineSendMessage,
  getWorkspaceFiles,
  listGeminiSessions,
  listMcpServerStatus,
  loadClaudeSession,
  sendUserMessage,
} from "../../../services/tauri";
import { getClientStoreSync } from "../../../services/clientStorage";
import { clearGlobalRuntimeNotices } from "../../../services/globalRuntimeNotices";
import { sendSharedSessionTurn } from "../../shared-session/runtime/sendSharedSessionTurn";
import { useThreadMessaging } from "./useThreadMessaging";

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

vi.mock("../../../services/tauri", () => ({
  compactThreadContext: vi.fn(),
  sendUserMessage: vi.fn(),
  projectMemoryCaptureAuto: vi.fn(async () => null),
  projectMemoryCaptureTurnInput: vi.fn(async () => null),
  startReview: vi.fn(),
  interruptTurn: vi.fn(),
  listMcpServerStatus: vi.fn(),
  getOpenCodeMcpStatus: vi.fn(),
  getOpenCodeLspDiagnostics: vi.fn(),
  getOpenCodeLspSymbols: vi.fn(),
  getOpenCodeLspDocumentSymbols: vi.fn(),
  importOpenCodeSession: vi.fn(),
  exportOpenCodeSession: vi.fn(),
  getOpenCodeStats: vi.fn(),
  getWorkspaceFiles: vi.fn(),
  shareOpenCodeSession: vi.fn(),
  listExternalSpecTree: vi.fn(),
  listGitBranches: vi.fn(),
  getGitLog: vi.fn(),
  listGeminiSessions: vi.fn(),
  loadClaudeSession: vi.fn(),
  engineSendMessage: vi.fn(),
  engineInterruptTurn: vi.fn(),
  engineInterrupt: vi.fn(),
}));

vi.mock("../../../services/clientStorage", () => ({
  getClientStoreSync: vi.fn(),
  writeClientStoreValue: vi.fn(),
}));

vi.mock("../../shared-session/runtime/sendSharedSessionTurn", () => ({
  sendSharedSessionTurn: vi.fn(),
}));

describe("useThreadMessaging optimistic render", () => {
  const workspace: WorkspaceInfo = {
    id: "ws-1",
    name: "ccgui",
    path: "/tmp/mossx",
    connected: true,
    settings: { sidebarCollapsed: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearGlobalRuntimeNotices();
    vi.mocked(getClientStoreSync).mockReturnValue(undefined);
    vi.mocked(engineSendMessage).mockResolvedValue({
      result: { turn: { id: "turn-1" } },
    });
    vi.mocked(sendUserMessage).mockResolvedValue({
      result: { turn: { id: "turn-2" } },
    });
    vi.mocked(getWorkspaceFiles).mockResolvedValue({
      files: [
        "openspec/changes/add-spec-hub/proposal.md",
        "openspec/changes/add-spec-hub/tasks.md",
      ],
      directories: ["openspec", "openspec/changes", "openspec/specs"],
      gitignored_files: [],
      gitignored_directories: [],
    });
    vi.mocked(listGeminiSessions).mockResolvedValue([]);
    vi.mocked(loadClaudeSession).mockResolvedValue({ messages: [] });
    vi.mocked(listMcpServerStatus).mockResolvedValue({ result: { data: [] } });
    vi.mocked(sendSharedSessionTurn).mockResolvedValue({
      result: { turn: { id: "shared-turn-1" } },
    });
  });

  function makeHook(
    activeEngine: "claude" | "codex" | "gemini" | "opencode",
    overrides: {
      activeThreadId?: string | null;
      dispatch?: ReturnType<typeof vi.fn>;
      ensuredThreadId?: string | null;
      itemsByThread?: Record<string, ConversationItem[]>;
      threadEngineById?: Record<string, "claude" | "codex" | "gemini" | "opencode" | undefined>;
    } = {},
  ) {
    const activeThreadId =
      "activeThreadId" in overrides ? overrides.activeThreadId ?? null : "thread-1";
    const ensuredThreadId =
      "ensuredThreadId" in overrides ? overrides.ensuredThreadId ?? null : activeThreadId;
    const dispatch = overrides.dispatch ?? vi.fn();

    const hook = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId,
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        steerEnabled: false,
        customPrompts: [],
        activeEngine,
        threadStatusById: {},
        itemsByThread: overrides.itemsByThread ?? {},
        activeTurnIdByThread: {},
        codexAcceptedTurnByThread: {},
        tokenUsageByThread: {},
        rateLimitsByWorkspace: {},
        codexCompactionInFlightByThreadRef: { current: {} },
        pendingInterruptsRef: { current: new Map<string, Map<string, true>>() },
        interruptedThreadsRef: { current: new Map<string, Map<string, true>>() },
        dispatch,
        getCustomName: () => undefined,
        getThreadEngine: (_workspaceId, threadId) =>
          overrides.threadEngineById?.[threadId] ?? undefined,
        getThreadKind: (_workspaceId, threadId) =>
          threadId.startsWith("shared:") ? "shared" : "native",
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: async () => ensuredThreadId,
        ensureThreadForWorkspace: async () => ensuredThreadId,
        refreshThread: async () => null,
        forkThreadForWorkspace: async () => null,
        updateThreadParent: vi.fn(),
        startThreadForWorkspace: vi.fn(async () => ensuredThreadId),
        onDebug: vi.fn(),
      }),
    );

    return { ...hook, dispatch };
  }

  function findOptimisticUserCall(dispatch: ReturnType<typeof vi.fn>) {
    return dispatch.mock.calls.find(
      ([action]) =>
        action &&
        typeof action === "object" &&
        "type" in action &&
        (action as { type?: string }).type === "upsertItem" &&
        "item" in action &&
        (action as { item?: { kind?: string; role?: string } }).item?.kind === "message" &&
        (action as { item?: { kind?: string; role?: string } }).item?.role === "user",
    );
  }

  function findGeneratedImageCalls(dispatch: ReturnType<typeof vi.fn>) {
    return dispatch.mock.calls.filter(
      ([action]) =>
        action &&
        typeof action === "object" &&
        "type" in action &&
        (action as { type?: string }).type === "upsertItem" &&
        "item" in action &&
        (action as { item?: { kind?: string } }).item?.kind === "generatedImage",
    );
  }

  it("adds optimistic user bubble immediately for codex send", async () => {
    const { result, dispatch } = makeHook("codex");

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "hello codex");
    });

    const optimisticCall = findOptimisticUserCall(dispatch);
    expect(optimisticCall).toBeDefined();
    const optimisticAction = optimisticCall?.[0] as { item?: { id?: string; text?: string } };
    expect(optimisticAction.item?.id).toMatch(/^optimistic-user-/);
    expect(optimisticAction.item?.text).toBe("hello codex");
  });

  it("uses the queued optimistic id even when normal optimistic rendering is skipped", async () => {
    const { result, dispatch } = makeHook("codex");
    const queuedOptions = {
      eagerOptimisticUserId: "optimistic-user-queued-message-1",
      skipOptimisticUserBubble: true,
    } as MessageSendOptions;

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "第二条排队消息",
        [],
        queuedOptions,
      );
    });

    const optimisticCall = findOptimisticUserCall(dispatch);
    expect(optimisticCall).toBeDefined();
    const optimisticAction = optimisticCall?.[0] as { item?: { id?: string; text?: string } };
    expect(optimisticAction.item?.id).toBe("optimistic-user-queued-message-1");
    expect(optimisticAction.item?.text).toBe("第二条排队消息");
  });

  it("adds generated image processing card for direct codex image request text", async () => {
    const { result, dispatch } = makeHook("codex");

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "给我生成一张图，赛博城市夜景",
      );
    });

    const optimisticUserId = (
      findOptimisticUserCall(dispatch)?.[0] as { item?: { id?: string } } | undefined
    )?.item?.id;
    const generatedImageCalls = findGeneratedImageCalls(dispatch);
    expect(generatedImageCalls).toHaveLength(1);
    expect(generatedImageCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: workspace.id,
        threadId: "thread-1",
        item: expect.objectContaining({
          id: expect.stringMatching(/^optimistic-generated-image:thread-1:/),
          kind: "generatedImage",
          status: "processing",
          sourceToolName: "image_generation_call",
          promptText: "给我生成一张图，赛博城市夜景",
          anchorUserMessageId: optimisticUserId,
          images: [],
        }),
      }),
    );
  });

  it("adds processing generated image card for explicit codex imagegen command", async () => {
    const { result, dispatch } = makeHook("codex");

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "imagegen 飓风");
    });

    const optimisticUserId = (
      findOptimisticUserCall(dispatch)?.[0] as { item?: { id?: string } } | undefined
    )?.item?.id;
    const generatedImageCalls = findGeneratedImageCalls(dispatch);
    expect(generatedImageCalls).toHaveLength(1);
    expect(generatedImageCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: workspace.id,
        threadId: "thread-1",
        item: expect.objectContaining({
          id: expect.stringMatching(/^optimistic-generated-image:thread-1:/),
          kind: "generatedImage",
          status: "processing",
          sourceToolName: "image_generation_call",
          promptText: "飓风",
          anchorUserMessageId: optimisticUserId,
          images: [],
        }),
      }),
    );
  });

  it.each([
    ["ordinary codex text", "hello codex"],
    ["imagegen implementation discussion", "这种情况你看看，生成图片 placeholder 在 reducer 里还是误触发了。"],
    [
      "image feature proposal text",
      "如果有用户让你生成图片时，幕布上要能加载出来生成的图片和制作中状态。",
    ],
  ])("does not add generated image placeholder for %s", async (_name, prompt) => {
    const { result, dispatch } = makeHook("codex");

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", prompt);
    });

    expect(findGeneratedImageCalls(dispatch)).toHaveLength(0);
  });

  it("does not infer generated image card from recent text context", async () => {
    const { result, dispatch } = makeHook("codex", {
      itemsByThread: {
        "thread-1": [
          {
            id: "assistant-image-offer",
            kind: "message",
            role: "assistant",
            text: "可以使用 imagegen skill，按这个方向生成一张图。",
          },
        ],
      },
    });

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "来一张吧");
    });

    expect(findGeneratedImageCalls(dispatch)).toHaveLength(0);
  });

  it("suppresses rendered user bubbles when send opts request silent execution prompts", async () => {
    const { result, dispatch } = makeHook("claude", {
      activeThreadId: "claude:session-1",
      ensuredThreadId: "claude:session-1",
      threadEngineById: { "claude:session-1": "claude" },
    });

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "claude:session-1",
        "Implement this plan.",
        [],
        { suppressUserMessageRender: true },
      );
    });

    expect(findOptimisticUserCall(dispatch)).toBeUndefined();
    expect(engineSendMessage).toHaveBeenCalled();
  });
});
