import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key, KeyboardEvent } from "react";
import { Select, SelectItem } from "@/components/base/select/select";
import { Input } from "@/components/base/input/input";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings } from "@/lib/ipc";
import { applyTheme } from "./theme";
import { useChatStore } from "@/features/chat/store";

export const LANGUAGE_STORAGE_KEY = "ccgui-next.language";

/** Compact select trigger (h 32, radius/lg) per the Figma settings rows. */
const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";
/** Sidebar thread limit bounds (integers only). */
const THREAD_LIMIT_MIN = 1;
const THREAD_LIMIT_MAX = 30;
const THREAD_LIMIT_DEFAULT = 5;

/** General page: appearance (theme/language/thread limit) + behavior
 *  (composer send shortcut, terminal shell override). */
export function GeneralSection() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Raw digits while editing the thread limit; null = show the saved value.
  const [limitText, setLimitText] = useState<string | null>(null);
  // Raw text while editing the shell path; null = show the saved value.
  const [shellText, setShellText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getAppSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        applyTheme(s.theme);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // "system" theme follows the OS via a listener bound at the app root
  // (App.tsx → bindSystemThemeSync), so it works without opening Settings.

  // Read-modify-write: the local `settings` descends from a mount-time
  // snapshot; persisting it whole would clobber concurrent edits (CLI config
  // page, chat-side model pinning). Apply each patch onto a fresh read.
  const save = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      const latest = await ipc.getAppSettings();
      const next = { ...latest, ...patch };
      await ipc.updateAppSettings(next);
      setSettings(next);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const onThemeChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const theme = String(key);
    setSettings({ ...settings, theme });
    applyTheme(theme);
    void save({ theme });
  };

  const onLanguageChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const language = String(key);
    setSettings({ ...settings, language });
    void i18n.changeLanguage(language);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    void save({ language });
  };
  const commitThreadLimit = (n: number) => {
    if (!settings || n === settings.sidebarThreadLimit) return;
    setSettings({ ...settings, sidebarThreadLimit: n });
    useChatStore.getState().setThreadLimit(n);
    void save({ sidebarThreadLimit: n });
  };
  // Typing only edits the raw text; committing per keystroke would fire a
  // settings write per digit. Commit on blur or Enter instead.
  const onThreadLimitChange = (v: string) => {
    if (!settings) return;
    setLimitText(v.replace(/\D/g, ""));
  };
  const commitThreadLimitText = () => {
    if (settings && limitText) {
      const n = Number(limitText);
      commitThreadLimit(Math.min(THREAD_LIMIT_MAX, Math.max(THREAD_LIMIT_MIN, n)));
    }
    setLimitText(null);
  };
  const onThreadLimitKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitThreadLimitText();
      (e.target as HTMLElement).blur();
    }
  };
  const onSendShortcutChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const composerSendShortcut = String(key);
    setSettings({ ...settings, composerSendShortcut });
    useChatStore.getState().setSendShortcut(composerSendShortcut);
    void save({ composerSendShortcut });
  };

  // Empty means "auto-detect"; the backend validates the path as a spawn
  // target and rejects it (with an error) when it doesn't resolve.
  const commitShellPath = () => {
    if (settings && shellText !== null) {
      const terminalShellPath = shellText.trim() || null;
      if (terminalShellPath !== (settings.terminalShellPath ?? null)) {
        setSettings({ ...settings, terminalShellPath });
        void save({ terminalShellPath });
      }
    }
    setShellText(null);
  };
  const onShellPathKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitShellPath();
      (e.target as HTMLElement).blur();
    }
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {!settings && !error && (
        <p className="text-body-regular text-text-tertiary">{t("common.loading")}</p>
      )}
      {settings && (
        <div className="flex w-full flex-col gap-2">
          <SettingsSectionLabel>{t("settings.appearance")}</SettingsSectionLabel>
          <SettingsCard>
            <SettingsRow label={t("settings.theme")}>
              <Select
                aria-label={t("settings.theme")}
                selectedKey={settings.theme}
                onSelectionChange={onThemeChange}
                triggerClassName={SELECT_TRIGGER}
              >
                <SelectItem id="system">{t("settings.themeSystem")}</SelectItem>
                <SelectItem id="light">{t("settings.themeLight")}</SelectItem>
                <SelectItem id="dark">{t("settings.themeDark")}</SelectItem>
              </Select>
            </SettingsRow>
            <SettingsRow label={t("settings.language")}>
              <Select
                aria-label={t("settings.language")}
                selectedKey={settings.language}
                onSelectionChange={onLanguageChange}
                triggerClassName={SELECT_TRIGGER}
              >
                <SelectItem id="zh">{t("settings.langZh")}</SelectItem>
                <SelectItem id="en">{t("settings.langEn")}</SelectItem>
              </Select>
            </SettingsRow>
            <SettingsRow label={t("settings.sidebarThreadLimit")}>
              <Input
                aria-label={t("settings.sidebarThreadLimit")}
                size="small"
                className="w-20"
                inputClassName="text-center"
                inputMode="numeric"
                value={
                  limitText ??
                  String(settings.sidebarThreadLimit ?? THREAD_LIMIT_DEFAULT)
                }
                onChange={onThreadLimitChange}
                onBlur={commitThreadLimitText}
                onKeyDown={onThreadLimitKeyDown}
              />
            </SettingsRow>
          </SettingsCard>
        </div>
      )}
      {settings && (
        <div className="flex w-full flex-col gap-2">
          <SettingsSectionLabel>{t("settings.behavior")}</SettingsSectionLabel>
          <SettingsCard>
            <SettingsRow label={t("settings.sendShortcut")}>
              <Select
                aria-label={t("settings.sendShortcut")}
                selectedKey={settings.composerSendShortcut ?? "enter"}
                onSelectionChange={onSendShortcutChange}
                triggerClassName={SELECT_TRIGGER}
              >
                <SelectItem id="enter">{t("settings.sendShortcutEnter")}</SelectItem>
                <SelectItem id="cmdEnter">{t("settings.sendShortcutCmdEnter")}</SelectItem>
              </Select>
            </SettingsRow>
            <SettingsRow label={t("settings.terminalShell")}>
              <Input
                aria-label={t("settings.terminalShell")}
                size="small"
                className="w-[240px]"
                placeholder={t("settings.terminalShellPlaceholder")}
                value={shellText ?? settings.terminalShellPath ?? ""}
                onChange={setShellText}
                onBlur={commitShellPath}
                onKeyDown={onShellPathKeyDown}
              />
            </SettingsRow>
          </SettingsCard>
        </div>
      )}
    </div>
  );
}
