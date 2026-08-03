// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_PROVIDER_PRESETS,
  DEFAULT_CODEX_AUTH_JSON,
  OFFICIAL_CODEX_CONFIG_TOML,
  OFFICIAL_CODEX_PROVIDER_NAME,
} from "../types";
import type { CodexProviderConfig } from "../types";
import { CodexProviderDialog } from "./CodexProviderDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderDialog(provider: CodexProviderConfig | null = null) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const renderResult = render(
    <CodexProviderDialog
      isOpen
      provider={provider}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { ...renderResult, onSave, onClose };
}

describe("CodexProviderDialog", () => {
  it("add mode renders official direct plus proxy presets with official selected", () => {
    const { container } = renderDialog();

    expect(container.querySelector(".vendor-security-notice")).toBeTruthy();

    const presetButtons = container.querySelectorAll(".vendor-preset-btn");
    expect(presetButtons).toHaveLength(CODEX_PROVIDER_PRESETS.length + 1);

    const officialButton = presetButtons[0];
    expect(officialButton.className).toContain("active");
    expect(officialButton.querySelector("img")).toBeTruthy();

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='settings.vendor.codexDialog.namePlaceholder']",
    );
    expect(nameInput?.value).toBe(OFFICIAL_CODEX_PROVIDER_NAME);

    const editors = container.querySelectorAll<HTMLTextAreaElement>(
      ".vendor-code-editor",
    );
    expect(editors[0]?.value).toBe(OFFICIAL_CODEX_CONFIG_TOML);
    expect(editors[1]?.value).toBe(DEFAULT_CODEX_AUTH_JSON);
  });

  it("fills fields from a clicked proxy preset", () => {
    const { container } = renderDialog();
    const preset = CODEX_PROVIDER_PRESETS.find((item) => item.id !== "custom");
    expect(preset).toBeTruthy();

    const presetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".vendor-preset-btn"),
    ).find((button) => button.textContent === preset!.nameKey);
    expect(presetButton).toBeTruthy();
    fireEvent.click(presetButton!);

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='settings.vendor.codexDialog.namePlaceholder']",
    );
    expect(nameInput?.value).toBe(preset!.name);

    const editors = container.querySelectorAll<HTMLTextAreaElement>(
      ".vendor-code-editor",
    );
    expect(editors[0]?.value).toBe(preset!.configToml);
    expect(editors[1]?.value).toBe(preset!.authJson);
  });

  it("fills the Atlas Cloud chat completions preset", () => {
    const { container } = renderDialog();
    const preset = CODEX_PROVIDER_PRESETS.find(
      (item) => item.id === "atlas-cloud",
    );
    expect(preset).toBeTruthy();

    const presetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".vendor-preset-btn"),
    ).find((button) => button.textContent === preset!.nameKey);
    expect(presetButton).toBeTruthy();
    fireEvent.click(presetButton!);

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='settings.vendor.codexDialog.namePlaceholder']",
    );
    expect(nameInput?.value).toBe("Atlas Cloud");

    const configToml = container.querySelectorAll<HTMLTextAreaElement>(
      ".vendor-code-editor",
    )[0]?.value;
    expect(configToml).toContain(
      'base_url = "https://api.atlascloud.ai/v1"',
    );
    expect(configToml).toContain('model = "deepseek-ai/deepseek-v4-pro"');
    expect(configToml).toContain('model_provider = "atlas_cloud"');
    expect(configToml).toContain('wire_api = "chat"');
  });

  it("formats valid JSON and reports formatError for invalid JSON", () => {
    const { container } = renderDialog();
    const editors = container.querySelectorAll<HTMLTextAreaElement>(
      ".vendor-code-editor",
    );
    const formatButtons =
      container.querySelectorAll<HTMLButtonElement>(".vendor-btn-format");
    expect(formatButtons).toHaveLength(2);

    fireEvent.change(editors[1], { target: { value: '{"a":1}' } });
    fireEvent.click(formatButtons[1]);
    expect(editors[1].value).toBe('{\n  "a": 1\n}');
    expect(container.querySelector(".vendor-json-error")).toBeNull();

    fireEvent.change(editors[1], { target: { value: "not json" } });
    fireEvent.click(formatButtons[1]);
    expect(container.querySelector(".vendor-json-error")?.textContent).toBe(
      "settings.vendor.codexDialog.formatError",
    );
  });

  it("blocks save with authJsonError when auth.json is invalid", () => {
    const { container, onSave } = renderDialog();
    const editors = container.querySelectorAll<HTMLTextAreaElement>(
      ".vendor-code-editor",
    );
    fireEvent.change(editors[1], { target: { value: "{invalid" } });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".vendor-btn-save")!,
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector(".vendor-json-error")?.textContent).toBe(
      "settings.vendor.codexDialog.authJsonError",
    );
  });

  it("edit mode hides preset sections and shows the provider name in the title", () => {
    const provider: CodexProviderConfig = {
      id: "p1",
      name: "My Codex",
      configToml: 'model = "gpt-5"',
      authJson: "{}",
    };
    const { container } = renderDialog(provider);

    expect(container.querySelector(".vendor-preset-group")).toBeNull();
    expect(container.querySelector(".vendor-security-notice")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe(
      "settings.vendor.codexDialog.editTitle",
    );

    const nameInput = container.querySelector<HTMLInputElement>(
      "input[placeholder='settings.vendor.codexDialog.namePlaceholder']",
    );
    expect(nameInput?.value).toBe("My Codex");
  });
});
