import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AppSettings } from "../../../types";
import {
  formatShortcutForPlatform,
  isEditableShortcutTarget,
  matchesShortcutForPlatform,
} from "../../../utils/shortcuts";
import { clampUiScale, UI_SCALE_STEP } from "../../../utils/uiScale";

type UseUiScaleShortcutsOptions = {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
};

type UseUiScaleShortcutsResult = {
  uiScale: number;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  queueSaveSettings: (next: AppSettings) => Promise<AppSettings>;
};

export function useUiScaleShortcuts({
  settings,
  setSettings,
  saveSettings,
}: UseUiScaleShortcutsOptions): UseUiScaleShortcutsResult {
  const { t } = useTranslation();
  const uiScale = clampUiScale(settings.uiScale);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      getCurrentWebview()
        .setZoom(uiScale)
        .catch(() => undefined);
    } catch {
      // In non-Tauri previews, getCurrentWebview can throw before setZoom exists.
    }
  }, [uiScale]);

  const scaleShortcutTitle = useMemo(() => {
    const increase = formatShortcutForPlatform(settings.increaseUiScaleShortcut);
    const decrease = formatShortcutForPlatform(settings.decreaseUiScaleShortcut);
    const reset = formatShortcutForPlatform(settings.resetUiScaleShortcut);
    return t("settings.uiScaleShortcutTitle", {
      increase,
      decrease,
      reset,
    });
  }, [
    settings.decreaseUiScaleShortcut,
    settings.increaseUiScaleShortcut,
    settings.resetUiScaleShortcut,
    t,
  ]);
  const scaleShortcutText = t("settings.uiScaleShortcutText", {
    shortcuts: scaleShortcutTitle,
  });

  const saveQueueRef = useRef(Promise.resolve());
  const queueSaveSettings = useCallback(
    (next: AppSettings) => {
      const task = () => saveSettings(next);
      const queued = saveQueueRef.current.then(task, task);
      saveQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [saveSettings],
  );

  const handleScaleDelta = useCallback(
    (delta: number) => {
      setSettings((current) => {
        const nextScale = clampUiScale(current.uiScale + delta);
        if (nextScale === current.uiScale) {
          return current;
        }
        const nextSettings = {
          ...current,
          uiScale: nextScale,
        };
        void queueSaveSettings(nextSettings);
        return nextSettings;
      });
    },
    [queueSaveSettings, setSettings],
  );

  const handleScaleReset = useCallback(() => {
    setSettings((current) => {
      if (current.uiScale === 1) {
        return current;
      }
      const nextSettings = {
        ...current,
        uiScale: 1,
      };
      void queueSaveSettings(nextSettings);
      return nextSettings;
    });
  }, [queueSaveSettings, setSettings]);

  useEffect(() => {
    const handleScaleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (
        isEditableShortcutTarget(event.target) ||
        isEditableShortcutTarget(document.activeElement)
      ) {
        return;
      }
      const isIncrease = matchesShortcutForPlatform(
        event,
        settings.increaseUiScaleShortcut,
      );
      const isDecrease = matchesShortcutForPlatform(
        event,
        settings.decreaseUiScaleShortcut,
      );
      const isReset = matchesShortcutForPlatform(
        event,
        settings.resetUiScaleShortcut,
      );
      if (!isIncrease && !isDecrease && !isReset) {
        return;
      }
      event.preventDefault();
      if (isReset) {
        handleScaleReset();
        return;
      }
      handleScaleDelta(isDecrease ? -UI_SCALE_STEP : UI_SCALE_STEP);
    };
    window.addEventListener("keydown", handleScaleShortcut);
    return () => {
      window.removeEventListener("keydown", handleScaleShortcut);
    };
  }, [
    handleScaleDelta,
    handleScaleReset,
    settings.decreaseUiScaleShortcut,
    settings.increaseUiScaleShortcut,
    settings.resetUiScaleShortcut,
  ]);

  return {
    uiScale,
    scaleShortcutTitle,
    scaleShortcutText,
    queueSaveSettings,
  };
}
