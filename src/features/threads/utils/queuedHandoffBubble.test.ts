import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../../types";
import {
  appendQueuedHandoffBubbleIfNeeded,
  buildQueuedHandoffBubbleItem,
  hasPendingOptimisticUserBubble,
} from "./queuedHandoffBubble";

describe("queuedHandoffBubble", () => {
  it("appends a queued handoff bubble when no matching user message exists yet", () => {
    const bubble = buildQueuedHandoffBubbleItem({
      id: "queued-1",
      text: "继续排查这个问题",
      createdAt: 1,
      images: ["local://image-1"],
      sendOptions: {
        selectedAgent: {
          id: "agent-1",
          name: "排障助手",
          icon: "agent-robot-02",
        },
      },
    });

    const merged = appendQueuedHandoffBubbleIfNeeded([], bubble);

    expect(merged).toEqual([bubble]);
  });

  it("keeps a queued handoff bubble before successor assistant output using its captured tail anchor", () => {
    const bubble = Object.assign(
      buildQueuedHandoffBubbleItem({
        id: "queued-anchored",
        text: "继续推送这个分支",
        createdAt: 1,
      }),
      { anchorItemId: "assistant-previous-turn" },
    );
    const items: ConversationItem[] = [
      {
        id: "assistant-previous-turn",
        kind: "message",
        role: "assistant",
        text: "上一轮输出已经结束。",
      },
      {
        id: "assistant-successor-turn",
        kind: "message",
        role: "assistant",
        text: "这是下一轮已经先到达的回复。",
      },
    ];

    const merged = appendQueuedHandoffBubbleIfNeeded(items, bubble);

    expect(merged.map((item) => item.id)).toEqual([
      "assistant-previous-turn",
      bubble.id,
      "assistant-successor-turn",
    ]);
  });

  it("does not mistake an earlier equal user message for the anchored handoff canonical item", () => {
    const bubble = buildQueuedHandoffBubbleItem(
      {
        id: "queued-repeated-text",
        text: "继续排查这个问题",
        createdAt: 1,
        eagerOptimisticUserId: "optimistic-user-queued-repeated-text",
      },
      "assistant-previous-turn",
    );
    const items: ConversationItem[] = [
      {
        id: "user-earlier-turn",
        kind: "message",
        role: "user",
        text: "继续排查这个问题",
      },
      {
        id: "assistant-previous-turn",
        kind: "message",
        role: "assistant",
        text: "上一轮输出已经结束。",
      },
      {
        id: "assistant-successor-turn",
        kind: "message",
        role: "assistant",
        text: "这是下一轮已经先到达的回复。",
      },
    ];

    const merged = appendQueuedHandoffBubbleIfNeeded(items, bubble);

    expect(merged.map((item) => item.id)).toEqual([
      "user-earlier-turn",
      "assistant-previous-turn",
      bubble.id,
      "assistant-successor-turn",
    ]);
  });

  it("does not append the handoff bubble when history already contains the matching user message", () => {
    const bubble = buildQueuedHandoffBubbleItem({
      id: "queued-2",
      text: "hello codex",
      createdAt: 1,
    });
    const items: ConversationItem[] = [
      {
        id: "user-history-1",
        kind: "message",
        role: "user",
        text: "[Spec Root Priority] ... [User Input] hello codex",
      },
    ];

    const merged = appendQueuedHandoffBubbleIfNeeded(items, bubble);

    expect(merged).toEqual(items);
  });

  it("treats optimistic user bubbles as pending until authoritative history catches up", () => {
    const items: ConversationItem[] = [
      {
        id: "optimistic-user-1",
        kind: "message",
        role: "user",
        text: "排查一下这条 Computer Use 链路",
      },
    ];

    expect(hasPendingOptimisticUserBubble(items)).toBe(true);
    expect(
      hasPendingOptimisticUserBubble([
        {
          id: "user-history-1",
          kind: "message",
          role: "user",
          text: "排查一下这条 Computer Use 链路",
        },
      ]),
    ).toBe(false);
  });

  it("preserves browser context attachment metadata across queued handoff", () => {
    const bubble = buildQueuedHandoffBubbleItem({
      id: "queued-browser",
      text: "分析这个页面",
      createdAt: 1,
      sendOptions: {
        browserContextAttachment: {
          kind: "browser_snapshot",
          attachmentId: "browser-attachment-1",
          browserSessionId: "browser-session-1",
          snapshotId: "browser-snapshot-1",
          workspaceId: "/repo",
          title: "Example",
          url: "https://example.com",
          capturedAt: 100,
          stale: false,
          summary: "bounded facts",
          visibleTextExcerpt: "primary browser facts",
          pageType: "issue",
          primaryContent: "primary browser facts",
          readableBlocks: [
            {
              blockId: "issue-body",
              role: "issue_body",
              text: "primary browser facts",
              score: 900,
              truncated: false,
            },
          ],
          noiseDiagnostics: [],
          visualEvidence: [
            {
              evidenceId: "visual-1",
              kind: "image",
              label: "issue screenshot",
              altText: "error screenshot",
              srcOrigin: "https://example.com",
              nearbyText: "screenshot context",
              visible: true,
              sensitive: false,
            },
          ],
          elementCounts: {
            headings: 1,
            links: 2,
            buttons: 3,
            forms: 0,
            landmarks: 1,
            codeCandidates: 0,
            readableBlocks: 1,
            visualEvidence: 1,
          },
          diagnostics: [],
          budget: {
            charLimit: 12_000,
            visibleTextLimit: 8_000,
            elementLimit: 120,
            formFieldLimit: 80,
            diagnosticLimit: 50,
            tokenEstimate: null,
            truncated: false,
            omittedElementCount: 0,
          },
          codeCandidates: [],
          privacy: {
            redactionApplied: false,
            redactedKinds: [],
            omittedKinds: ["raw_dom"],
          },
        },
      },
    });

    expect(bubble.browserContextAttachment?.snapshotId).toBe("browser-snapshot-1");
    expect(bubble.browserContextAttachment?.pageType).toBe("issue");
    expect(bubble.browserContextAttachment?.visualEvidence?.[0]?.label).toBe("issue screenshot");
  });
});
