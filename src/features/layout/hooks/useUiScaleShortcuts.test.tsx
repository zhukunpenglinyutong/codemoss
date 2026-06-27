/* @vitest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../types";

const webviewMocks = vi.hoisted(() => ({
  getCurrentWebview: vi.fn(),
  setZoom: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: webviewMocks.getCurrentWebview,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { useUiScaleShortcuts } from "./useUiScaleShortcuts";

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    uiScale: 1,
    increaseUiScaleShortcut: "cmd+=",
    decreaseUiScaleShortcut: "cmd+-",
    resetUiScaleShortcut: "cmd+0",
    ...overrides,
  } as AppSettings;
}

describe("useUiScaleShortcuts", () => {
  beforeEach(() => {
    webviewMocks.getCurrentWebview.mockReset();
    webviewMocks.setZoom.mockReset();
    webviewMocks.setZoom.mockResolvedValue(undefined);
    webviewMocks.getCurrentWebview.mockReturnValue({
      setZoom: webviewMocks.setZoom,
    });
  });

  it("applies the UI scale to the current Tauri webview", async () => {
    renderHook(() =>
      useUiScaleShortcuts({
        settings: createSettings({ uiScale: 1.25 }),
        setSettings: vi.fn(),
        saveSettings: vi.fn(async (next: AppSettings) => next),
      }),
    );

    await waitFor(() => {
      expect(webviewMocks.setZoom).toHaveBeenCalledWith(1.25);
    });
  });

  it("does not crash in a web preview when Tauri webview metadata is unavailable", () => {
    webviewMocks.getCurrentWebview.mockImplementation(() => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'metadata')",
      );
    });

    expect(() =>
      renderHook(() =>
        useUiScaleShortcuts({
          settings: createSettings(),
          setSettings: vi.fn(),
          saveSettings: vi.fn(async (next: AppSettings) => next),
        }),
      ),
    ).not.toThrow();
  });
});
