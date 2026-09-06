import type { ITheme } from "@xterm/xterm";

export const TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';

/**
 * Palettes keyed off the app's `.dark` class rather than read from CSS
 * variables: Tailwind v4 tokens serialize as oklch()/color-mix(), which
 * xterm's color parser (hex/rgb only) rejects. Values mirror the app theme:
 * dark background matches --color-neutral-925 (#121212), ANSI colors follow
 * the VS Code dark/light palettes.
 */
export function terminalTheme(): ITheme {
  if (document.documentElement.classList.contains("dark")) {
    return {
      background: "#121212",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
      selectionBackground: "rgba(255, 255, 255, 0.22)",
      black: "#000000",
      red: "#cd3131",
      green: "#0dbc79",
      yellow: "#e5e510",
      blue: "#2472c8",
      magenta: "#bc3fbc",
      cyan: "#11a8cd",
      white: "#e5e5e5",
      brightBlack: "#666666",
      brightRed: "#f14c4c",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#3b8eea",
      brightMagenta: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#ffffff",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "rgba(0, 0, 0, 0.16)",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  };
}
