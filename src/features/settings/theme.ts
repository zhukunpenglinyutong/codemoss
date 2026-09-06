import { ipc } from "@/lib/ipc";
/** localStorage key holding the last applied theme, read pre-paint by main.tsx. */
export const THEME_STORAGE_KEY = "boardui:theme";
/** Window event fired by a theme toggle control; carries "dark" | "light". */
export const THEME_CHANGE_EVENT = "boardui:theme-change";

/**
 * Apply the persisted theme to the document root.
 * "system" resolves through the OS color-scheme media query.
 */
export function applyTheme(theme: string): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  // Mirror the applied theme into storage for main.tsx's pre-paint read.
  window.localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
}

/** Persist a theme change (from a toggle control) back into app settings. */
export function bindThemeChangePersistence(): () => void {
  const onChange = (event: Event) => {
    const theme = (event as CustomEvent<string>).detail === "dark" ? "dark" : "light";
    ipc
      .getAppSettings()
      .then((settings) => ipc.updateAppSettings({ ...settings, theme }))
      .catch(() => {});
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

/** Follow OS color-scheme flips while the saved theme is "system". Bound at
 * the app root (not the settings page) so it works without opening Settings.
 * The current setting is re-read on every flip, so no re-subscription is
 * needed when the user changes themes. */
export function bindSystemThemeSync(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    ipc
      .getAppSettings()
      .then((settings) => {
        if (settings.theme === "system") applyTheme("system");
      })
      .catch(() => {});
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
