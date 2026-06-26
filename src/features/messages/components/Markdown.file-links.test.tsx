// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown file links", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes absolute file links to the file opener callback", () => {
    const onOpenFileLink = vi.fn();

    render(
      <Markdown
        value={
          "文件: [collaboration_policy.rs](/Users/test/Library/Application%20Support/repo/src-tauri/src/codex/collaboration_policy.rs#L42)"
        }
        onOpenFileLink={onOpenFileLink}
      />,
    );

    fireEvent.click(
      screen.getByRole("link", { name: "collaboration_policy.rs" }),
    );

    expect(onOpenFileLink).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/repo/src-tauri/src/codex/collaboration_policy.rs#L42",
    );
  });

  it("renders image tags declared with <image>url</image>", async () => {
    const { container } = render(<Markdown value="<image>https://example.com/a.png</image>" />);

    await waitFor(() => {
      expect(container.querySelector("img")).toBeTruthy();
    });
    const img = container.querySelector("img") as HTMLImageElement | null;
    expect(img).toBeTruthy();
    if (!img) {
      return;
    }
    expect(img.src).toContain("https://example.com/a.png");
  });

  it("does not transform <image> tag inside code fences", () => {
    const { container } = render(
      <Markdown
        value={"```text\n<image>https://example.com/a.png</image>\n```"}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByText("<image>https://example.com/a.png</image>"),
    ).toBeTruthy();
  });

  it("does not transform <image> tag inside inline code spans", () => {
    const { container } = render(
      <Markdown
        value={"路径是 `<image>https://example.com/a.png</image>`"}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByText("<image>https://example.com/a.png</image>"),
    ).toBeTruthy();
  });

  it("copies inline code from its copy button", async () => {
    const writeTextMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(<Markdown value={"运行 `npm run test` 后继续。"} />);

    fireEvent.click(screen.getByRole("button", { name: "messages.copyInlineCode" }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("npm run test");
    });
  });

  it("preserves fragmented inline code content during markdown normalization", () => {
    const { container } = render(
      <Markdown value={"命令是 `pnpm\nrun\nlint`，执行后继续。"} />,
    );

    const code = container.querySelector("code");
    expect(code?.textContent ?? "").toBe("pnpm run lint");
    expect(container.textContent ?? "").not.toContain("pnpmrunlint");
  });

  it("flushes the latest content immediately when streaming throttle changes", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(
      <Markdown
        value="draft"
        streamingThrottleMs={120}
      />,
    );

    rerender(
      <Markdown
        value="draft update"
        streamingThrottleMs={120}
      />,
    );
    expect(container.textContent ?? "").toContain("draft");
    expect(container.textContent ?? "").not.toContain("draft update");

    act(() => {
      rerender(
        <Markdown
          value="final answer"
          streamingThrottleMs={80}
        />,
      );
    });

    expect(container.textContent ?? "").toContain("final answer");
  });

  it("reports the exact rendered streaming value after throttle flushes", () => {
    vi.useFakeTimers();
    const onRenderedValueChange = vi.fn();
    const { rerender } = render(
      <Markdown
        value="draft"
        streamingThrottleMs={120}
        onRenderedValueChange={onRenderedValueChange}
      />,
    );

    expect(onRenderedValueChange).toHaveBeenLastCalledWith("draft");

    rerender(
      <Markdown
        value="draft update"
        streamingThrottleMs={120}
        onRenderedValueChange={onRenderedValueChange}
      />,
    );
    expect(onRenderedValueChange).not.toHaveBeenLastCalledWith("draft update");

    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(onRenderedValueChange).toHaveBeenLastCalledWith("draft update");
  });

  it("renders lightweight live markdown structure without the full plugin pipeline", () => {
    const { container } = render(
      <Markdown
        value={"## 实时结论：这是标题后的正文，应该被拆成段落，而不是把 ## 原样显示给用户。\n\n- 第一条 **重点**\n- 第二条 `code`\n\n```ts\nconst ok = true;\n```"}
        liveRenderMode="lightweight"
      />,
    );

    expect(container.querySelector("h2")?.textContent).toBe("实时结论");
    expect(container.textContent ?? "").not.toContain("## 实时结论");
    expect(container.querySelector("p")?.textContent).toContain(
      "这是标题后的正文",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("重点");
    expect(container.querySelector("code")?.textContent).toContain("code");
    expect(container.querySelector("pre")?.textContent).toContain("const ok = true;");
  });

  it("preserves lightweight live markdown blocks before fragmented text normalization", () => {
    const { container } = render(
      <Markdown
        value={[
          "## 一、问题定义：为什么实时对话界面更难优化",
          "这是一段连续正文，应该作为段落展示。",
          "",
          "## 二、优化目标",
          "",
          "- 首 token 可见",
          "- 流式输出期间平均帧稳定",
          "- composer 响应性",
          "- 回滚开关",
          "- 状态一致性",
        ].join("\n")}
        liveRenderMode="lightweight"
      />,
    );

    expect(container.querySelectorAll("h2")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.textContent ?? "").not.toContain("## 一、问题定义");
    expect(container.textContent ?? "").toContain("实时对话界面更难优化");
  });

  it("reveals large live markdown input progressively by readable blocks", () => {
    vi.useFakeTimers();
    const onRenderedValueChange = vi.fn();
    const largeStreamingValue = [
      "## 第一段",
      "",
      "这是第一段内容，用来确认初始帧能够先展示一个可读 block，而不是把后面的完整总结一次性塞进 UI。",
      "",
      "## 第二段",
      "",
      "这是第二段内容，模拟 Codex 在最后阶段一次送来较大 chunk 时，前端仍然按段落逐步显示。".repeat(6),
      "",
      "- 第三段要点一：保留 Markdown 结构",
      "- 第三段要点二：避免一次性长 DOM diff",
      "- 第三段要点三：让输入框仍然可操作",
      "- 第三段要点四：大块文本不应该阻塞整页交互",
      "- 第三段要点五：可见内容需要持续增长",
      "",
      "最终句子",
    ].join("\n");

    const { container } = render(
      <Markdown
        value={largeStreamingValue}
        liveRenderMode="lightweight"
        progressiveReveal
        progressiveRevealStepMs={28}
        progressiveRevealChunkChars={120}
        onRenderedValueChange={onRenderedValueChange}
      />,
    );

    expect(container.textContent ?? "").toContain("第一段");
    expect(container.textContent ?? "").not.toContain("最终句子");
    expect(onRenderedValueChange).not.toHaveBeenLastCalledWith(largeStreamingValue);

    act(() => {
      vi.advanceTimersByTime(28);
    });

    expect(container.textContent ?? "").toContain("第二段");
    expect(container.textContent ?? "").not.toContain("最终句子");

    act(() => {
      vi.advanceTimersByTime(280);
    });

    expect(container.textContent ?? "").toContain("最终句子");
    expect(onRenderedValueChange).toHaveBeenLastCalledWith(largeStreamingValue);
  });

  it("restarts progressive reveal when a completed codex message enters the finalizing window", () => {
    vi.useFakeTimers();
    const initialFinalValue = [
      "## 完成结论",
      "",
      "第一段",
      "",
      "第二段",
      "",
      "最终句子",
    ].join("\n");
    const expandedFinalValue = [
      initialFinalValue,
      "",
      "## 补齐段落",
      "",
      "这是 completion 才到达的大段内容，进入 finalizing window 时仍然需要分段显示。".repeat(12),
      "",
      "真正最终句子",
    ].join("\n");

    const { container, rerender } = render(
      <Markdown
        value={initialFinalValue}
        liveRenderMode="full"
        progressiveReveal={false}
      />,
    );
    expect(container.textContent ?? "").toContain("最终句子");

    rerender(
      <Markdown
        value={expandedFinalValue}
        liveRenderMode="lightweight"
        progressiveReveal
        progressiveRevealStepMs={28}
        progressiveRevealChunkChars={120}
      />,
    );

    expect(container.textContent ?? "").toContain("完成结论");
    expect(container.textContent ?? "").not.toContain("真正最终句子");

    for (let index = 0; index < 60; index += 1) {
      act(() => {
        vi.advanceTimersByTime(28);
      });
      if ((container.textContent ?? "").includes("真正最终句子")) {
        break;
      }
    }

    expect(container.textContent ?? "").toContain("真正最终句子");
  });

  it("renders final markdown immediately when progressive reveal is disabled", () => {
    const finalValue = [
      "## 完成结论",
      "",
      "第一段",
      "",
      "第二段",
      "",
      "最终句子",
    ].join("\n");

    const { container } = render(
      <Markdown
        value={finalValue}
        liveRenderMode="lightweight"
        progressiveReveal={false}
      />,
    );

    expect(container.textContent ?? "").toContain("最终句子");
  });

  it("keeps lightweight live markdown links on the safe URL boundary", () => {
    const { container } = render(
      <Markdown
        value={"危险链接：[bad](javascript:alert(1))"}
        liveRenderMode="lightweight"
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent ?? "").toContain("bad");
  });

  it("routes lightweight live markdown file links through the file opener callback", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value={"文件：[demo.ts](C:\\Users\\test\\repo\\demo.ts#L3)"}
        liveRenderMode="lightweight"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "demo.ts" }));

    expect(onOpenFileLink).toHaveBeenCalledWith("C:\\Users\\test\\repo\\demo.ts#L3");
  });

  it("falls back to safe progressive reveal defaults for non-finite inputs", () => {
    vi.useFakeTimers();
    const onRenderedValueChange = vi.fn();
    const finalValue = [
      "## 第一段",
      "",
      "这是第一段内容，确认异常配置不会让 progressive reveal 卡死。",
      "",
      "## 第二段",
      "",
      "这是第二段内容。".repeat(60),
      "",
      "最终句子",
    ].join("\n");

    const { container } = render(
      <Markdown
        value={finalValue}
        liveRenderMode="lightweight"
        progressiveReveal
        progressiveRevealStepMs={Number.NaN}
        progressiveRevealChunkChars={Number.POSITIVE_INFINITY}
        onRenderedValueChange={onRenderedValueChange}
      />,
    );

    expect(onRenderedValueChange).toHaveBeenCalled();

    for (let index = 0; index < 80; index += 1) {
      act(() => {
        vi.advanceTimersByTime(28);
      });
      if ((container.textContent ?? "").includes("最终句子")) {
        break;
      }
    }

    expect(container.textContent ?? "").toContain("最终句子");
    expect(onRenderedValueChange).toHaveBeenLastCalledWith(finalValue);
  });
});
