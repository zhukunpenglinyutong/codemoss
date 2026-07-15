// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeLogPanel } from "./RuntimeLogPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("RuntimeLogPanel command goal options", () => {
  it("shows node secondary command examples including tauri dev", async () => {
    render(
      <RuntimeLogPanel
        isVisible
        status="idle"
        log=""
        error={null}
        commandPresetOptions={["auto", "node-dev", "custom"]}
        commandPresetId="node-dev"
        commandInput="npm run dev"
        onCommandInputChange={() => undefined}
        onStop={() => undefined}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "files.runCommandGoalLabel" }));
    expect(await screen.findByText("tauri dev")).toBeTruthy();
  });

  it("provides node secondary command examples even when command input is empty", async () => {
    render(
      <RuntimeLogPanel
        isVisible
        status="idle"
        log=""
        error={null}
        commandPresetOptions={["auto", "node-dev", "custom"]}
        commandPresetId="node-dev"
        commandInput=""
        onCommandInputChange={() => undefined}
        onStop={() => undefined}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "files.runCommandGoalLabel" }));
    expect(await screen.findByText("tauri dev")).toBeTruthy();
  });

  it("styles CodePort runtime system lines with the system tone", () => {
    render(
      <RuntimeLogPanel
        isVisible
        status="running"
        log="[CodePort Run] Starting at 10:30:00"
        error={null}
        onStop={() => undefined}
        onClear={() => undefined}
      />,
    );

    const line = screen
      .getByText("[CodePort Run] Starting at 10:30:00")
      .closest(".runtime-console-line");
    expect(line?.className).toContain("is-system");
  });
});
