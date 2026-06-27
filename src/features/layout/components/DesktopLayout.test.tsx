// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopLayout } from "./DesktopLayout";

function renderDesktopLayout(overrides: Partial<ComponentProps<typeof DesktopLayout>> = {}) {
  return render(
    <DesktopLayout
      sidebarNode={<aside>sidebar</aside>}
      updateToastNode={<div>update-toast</div>}
      approvalToastsNode={<div>approval-toast</div>}
      errorToastsNode={<div>error-toast</div>}
      globalRuntimeNoticeDockNode={<div>runtime-notice-dock</div>}
      homeNode={<div>home</div>}
      showHome={false}
      showWorkspace
      showKanban={false}
      showGitHistory={false}
      hideRightPanel={false}
      isSoloMode={false}
      kanbanNode={<div>kanban</div>}
      gitHistoryNode={<div>git-history</div>}
      settingsOpen={false}
      settingsNode={<div>settings</div>}
      topbarLeftNode={<div>topbar-left</div>}
      centerMode="chat"
      editorSplitLayout="vertical"
      editorSplitCompanion="chat"
      isEditorFileMaximized={false}
      messagesNode={<div>messages</div>}
      gitDiffViewerNode={<div>git-diff-viewer</div>}
      fileViewPanelNode={<div>file-viewer</div>}
      rightPanelToolbarNode={<div>right-toolbar</div>}
      gitDiffPanelNode={<div>activity-panel</div>}
      planPanelNode={<div>plan-panel</div>}
      composerNode={<div className="composer">composer</div>}
      runtimeConsoleDockNode={<div>runtime-dock</div>}
      terminalDockNode={<div>terminal-dock</div>}
      debugPanelNode={<div>debug-panel</div>}
      hasActivePlan
      onSidebarResizeStart={vi.fn()}
      onRightPanelResizeStart={vi.fn()}
      onPlanPanelResizeStart={vi.fn()}
      onGitHistoryPanelResizeStart={vi.fn()}
      {...overrides}
    />,
  );
}

describe("DesktopLayout", () => {
  it("keeps plan section expanded in normal activity view", () => {
    const { container } = renderDesktopLayout();

    expect(container.textContent ?? "").toContain("activity-panel");
    expect(container.textContent ?? "").toContain("plan-panel");
    expect(container.textContent ?? "").toContain("runtime-notice-dock");

    const rightPanel = container.querySelector(".right-panel");
    expect(rightPanel?.className).not.toContain("plan-collapsed");
    expect(rightPanel?.className).not.toContain("is-solo");
  });

  it("collapses the plan section and marks the right panel in SOLO mode", () => {
    cleanup();
    const { container } = renderDesktopLayout({ isSoloMode: true });

    expect(container.textContent ?? "").toContain("activity-panel");
    expect(container.textContent ?? "").toContain("plan-panel");

    const rightPanel = container.querySelector(".right-panel");
    expect(rightPanel?.className).toContain("plan-collapsed");
    expect(rightPanel?.className).toContain("is-solo");
  });

  it("keeps right panel bottom collapsed when no merged plan node is mounted", () => {
    cleanup();
    const { container } = renderDesktopLayout({
      planPanelNode: null,
      hasActivePlan: true,
    });

    const rightPanel = container.querySelector(".right-panel");
    expect(rightPanel?.className).toContain("plan-collapsed");
    expect(container.querySelector(".right-panel-bottom")).toBeNull();
    expect(container.querySelector(".right-panel-divider")).toBeNull();
  });

  it("exposes clear right panel collapse and expand handles", () => {
    cleanup();
    const onCollapseRightPanel = vi.fn();
    const onExpandRightPanel = vi.fn();
    const { container, getByLabelText, rerender } = renderDesktopLayout({
      onCollapseRightPanel,
      onExpandRightPanel,
    });

    expect(getByLabelText("收起实时统计侧栏")).toBeTruthy();
    expect(container.querySelector(".right-panel-shell-toggle")).toBeTruthy();
    expect(container.querySelector(".right-panel-collapsed-rail")).toBeNull();

    rerender(
      <DesktopLayout
        sidebarNode={<aside>sidebar</aside>}
        updateToastNode={<div>update-toast</div>}
        approvalToastsNode={<div>approval-toast</div>}
        errorToastsNode={<div>error-toast</div>}
        globalRuntimeNoticeDockNode={<div>runtime-notice-dock</div>}
        homeNode={<div>home</div>}
        showHome={false}
        showWorkspace
        showKanban={false}
        showGitHistory={false}
        hideRightPanel={false}
        rightPanelCollapsed
        isSoloMode={false}
        kanbanNode={<div>kanban</div>}
        gitHistoryNode={<div>git-history</div>}
        settingsOpen={false}
        settingsNode={<div>settings</div>}
        topbarLeftNode={<div>topbar-left</div>}
        centerMode="chat"
        editorSplitLayout="vertical"
        editorSplitCompanion="chat"
        isEditorFileMaximized={false}
        messagesNode={<div>messages</div>}
        gitDiffViewerNode={<div>git-diff-viewer</div>}
        fileViewPanelNode={<div>file-viewer</div>}
        rightPanelToolbarNode={<div>right-toolbar</div>}
        gitDiffPanelNode={<div>activity-panel</div>}
        planPanelNode={<div>plan-panel</div>}
        composerNode={<div className="composer">composer</div>}
        runtimeConsoleDockNode={<div>runtime-dock</div>}
        terminalDockNode={<div>terminal-dock</div>}
        debugPanelNode={<div>debug-panel</div>}
        hasActivePlan
        onSidebarResizeStart={vi.fn()}
        onRightPanelResizeStart={vi.fn()}
        onPlanPanelResizeStart={vi.fn()}
        onGitHistoryPanelResizeStart={vi.fn()}
        onCollapseRightPanel={onCollapseRightPanel}
        onExpandRightPanel={onExpandRightPanel}
      />,
    );

    expect(getByLabelText("展开实时统计侧栏")).toBeTruthy();
    expect(container.querySelector(".right-panel-collapsed-rail")).toBeTruthy();
    expect(container.querySelector(".right-panel-shell-toggle")).toBeNull();
  });

  it("keeps the composer mounted when the editor file is maximized", () => {
    cleanup();
    const { container, getByText } = renderDesktopLayout({
      centerMode: "editor",
      isEditorFileMaximized: true,
    });

    expect(container.querySelector(".content.is-editor-file-maximized")).toBeTruthy();
    expect(container.textContent ?? "").toContain("file-viewer");
    expect(container.textContent ?? "").toContain("composer");

    const chatLayer = container.querySelector(".content-layer--chat");
    const composer = getByText("composer");
    expect(chatLayer?.contains(composer)).toBe(false);
  });

  it("places the composer inside the chat column in horizontal editor split", () => {
    cleanup();
    const { container, getByText } = renderDesktopLayout({
      centerMode: "editor",
      editorSplitLayout: "horizontal",
    });

    const content = container.querySelector(".content.is-editor-split-horizontal");
    const chatLayer = container.querySelector(".content-layer--chat");
    const editorLayer = container.querySelector(".content-layer--editor");
    const composer = getByText("composer");

    expect(content).toBeTruthy();
    expect(chatLayer?.contains(getByText("messages"))).toBe(true);
    expect(chatLayer?.contains(composer)).toBe(true);
    expect(editorLayer?.contains(getByText("file-viewer"))).toBe(true);
    expect(composer.parentElement).toBe(chatLayer);
  });

  it("uses Project Map as the editor split companion for evidence file navigation", () => {
    cleanup();
    const { container, getByText } = renderDesktopLayout({
      centerMode: "editor",
      editorSplitLayout: "horizontal",
      editorSplitCompanion: "projectMap",
      projectMapPanelNode: <div>project-map</div>,
    });

    const content = container.querySelector(".content.is-editor-split-horizontal");
    const projectMapLayer = container.querySelector(".content-layer--project-map");
    const chatLayer = container.querySelector(".content-layer--chat");
    const editorLayer = container.querySelector(".content-layer--editor");

    expect(content).toBeTruthy();
    expect(content?.className).not.toContain("is-editor-file-maximized");
    expect(projectMapLayer?.className).toContain("is-active");
    expect(projectMapLayer?.className).toContain("content-layer--editor-companion");
    expect(projectMapLayer?.getAttribute("aria-hidden")).toBe("false");
    expect(chatLayer?.className).toContain("is-hidden");
    expect(editorLayer?.contains(getByText("file-viewer"))).toBe(true);
    expect(projectMapLayer?.contains(getByText("project-map"))).toBe(true);
    expect(container.querySelector(".composer")).toBeNull();
  });

  it("keeps composer outside the chat layer in normal chat mode", () => {
    cleanup();
    const { container, getByText } = renderDesktopLayout();

    const chatLayer = container.querySelector(".content-layer--chat");
    const composer = getByText("composer");

    expect(chatLayer?.contains(composer)).toBe(false);
    expect(composer.parentElement?.className).toContain("main");
  });
});
