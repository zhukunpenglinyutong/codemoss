import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { loadXterm } from "./xterm-loader";
import { TERMINAL_FONT_FAMILY, terminalTheme } from "./appearance";
import {
  ensureTerminalOutputListener,
  hasTerminalSession,
  markTerminalClosed,
  markTerminalOpened,
  setTerminalWriter,
  terminalBacklog,
} from "./sessions";

/**
 * One xterm instance for the active tab; remounts per tab (key = tab id).
 * The backend PTY session persists across mounts and buffered output replays
 * into the fresh instance, so collapse/tab switches lose nothing.
 * Memoized: the dock re-renders per animation frame during height drags, and
 * an xterm re-render per frame would jank the drag.
 */
export const TerminalView = memo(function TerminalView({ id, cwd }: { id: string; cwd: string }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let teardown: (() => void) | null = null;

    ensureTerminalOutputListener();
    void loadXterm()
      .then(({ Terminal, FitAddon, WebglAddon }) => {
        if (disposed) return;
        let resizeTimer: number | undefined;
        const term = new Terminal({
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 12,
          cursorBlink: true,
          scrollback: 5000,
          theme: terminalTheme(),
          // Option-as-meta so word jumps (⌥←/⌥→) reach readline on macOS.
          macOptionIsMeta: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        try {
          // GPU renderer; falls back to canvas when WebGL is unavailable.
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          term.loadAddon(webgl);
        } catch {
          // Canvas renderer remains active.
        }

        const backlog = terminalBacklog(id);
        if (backlog) term.write(backlog);
        setTerminalWriter(id, (data) => term.write(data));

        const openSession = () =>
          ipc
            .terminalOpen({ id, cwd, cols: term.cols, rows: term.rows })
            .then(() => {
              markTerminalOpened(id);
              setError(null);
            })
            .catch((e: unknown) => setError(String(e)));

        const safeFit = () => {
          try {
            fit.fit();
          } catch {
            // Zero-size host mid-layout; the next ResizeObserver tick refits.
          }
        };
        safeFit();
        void openSession();

        const inputDisposable = term.onData((data) => {
          const write = () =>
            ipc.terminalWrite(id, data).catch((e: unknown) => {
              // Shell exited (exit/Ctrl-D): respawn, then deliver the input.
              if (String(e).includes("Terminal session not found")) {
                markTerminalClosed(id);
                void openSession().then(() =>
                  ipc.terminalWrite(id, data).catch(() => {}),
                );
              }
            });
          if (hasTerminalSession(id)) void write();
          else void openSession().then(write);
        });

        const resizeObserver = new ResizeObserver(() => {
          safeFit();
          // Fit every frame so the canvas tracks the drag; the PTY resize
          // itself waits for the drag to settle (one IPC per frame stalled
          // the backend and made resizing feel sticky).
          clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            resizeTimer = undefined;
            if (hasTerminalSession(id)) {
              void ipc.terminalResize(id, term.cols, term.rows).catch(() => {});
            }
          }, 150);
        });
        resizeObserver.observe(host);

        // Follow app theme flips (the dark class on <html>).
        const themeObserver = new MutationObserver(() => {
          term.options.theme = terminalTheme();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        teardown = () => {
          inputDisposable.dispose();
          resizeObserver.disconnect();
          clearTimeout(resizeTimer);
          themeObserver.disconnect();
          setTerminalWriter(id, null);
          term.dispose();
        };
      })
      .catch((e: unknown) => {
        if (!disposed) setError(String(e));
      });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [id, cwd]);

  return (
    <div className="relative min-h-0 flex-1 bg-background-full">
      <div ref={hostRef} className="terminal-host absolute inset-0" />
      {error && (
        <div className="absolute inset-x-0 top-0 z-10 border-b border-separator-border bg-background-quaternary-error px-3 py-1.5 text-caption-1-medium text-text-error-primary">
          {t("terminal.failed", { message: error })}
        </div>
      )}
    </div>
  );
});
