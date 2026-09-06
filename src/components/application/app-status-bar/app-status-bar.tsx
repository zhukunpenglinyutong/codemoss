import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Activity from "lucide-react/dist/esm/icons/activity";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ipc, type AppMetrics } from "@/lib/ipc";
import { listenScanProgress, type ScanProgress } from "@/lib/events";
import { readStoredNumber, writeStored } from "@/lib/storage";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { cx } from "@/utils/cx";

const ZOOM_KEY = "ccgui-next.zoom:v1";
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const METRICS_POLL_MS = 3000;

function readZoomPct(): number {
  const raw = readStoredNumber(ZOOM_KEY, 100);
  return raw >= ZOOM_MIN && raw <= ZOOM_MAX ? raw : 100;
}

function applyZoom(pct: number) {
  writeStored(ZOOM_KEY, pct);
  // Outside a Tauri webview (plain-browser dev) getCurrentWebview throws
  // synchronously; the bar still renders, zoom just stays inert.
  try {
    void getCurrentWebview()
      .setZoom(pct / 100)
      .catch(() => {});
  } catch {}
}

function formatMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** App-wide bottom chrome: performance, zoom, history-sync status, version. */
export function AppStatusBar() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [zoomPct, setZoomPct] = useState(readZoomPct);
  const [sync, setSync] = useState<ScanProgress | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  // Re-apply the persisted zoom on startup; Tauri does not restore it.
  useEffect(() => applyZoom(readZoomPct()), []);

  const changeZoom = useCallback((next: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next / ZOOM_STEP) * ZOOM_STEP));
    setZoomPct(clamped);
    applyZoom(clamped);
  }, []);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      // Skip ticks while the window is hidden (background tab / minimized):
      // the numbers are invisible anyway, so polling then is pure waste.
      if (document.hidden) return;
      ipc
        .appMetrics()
        .then((m) => {
          if (!cancelled) setMetrics(m);
        })
        .catch(() => {});
    };
    void poll();
    const timer = setInterval(poll, METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useTauriEvent(() => listenScanProgress(setSync));

  const syncPct = sync && sync.total > 0 ? Math.round((sync.done / sync.total) * 100) : 0;
  const syncing = !!sync && !sync.finished;
  const triggerSync = useCallback(() => {
    void ipc.rescanSessions().catch(() => {});
  }, []);
  const iconButton =
    "flex size-5 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-secondary";

  return (
    <div className="flex h-7 shrink-0 items-center justify-end border-t border-separator-border bg-background-full px-3 text-caption-1-medium text-text-tertiary select-none">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex items-center gap-1"
          title={
            metrics
              ? t("statusbar.perfDetail", {
                  mb: formatMb(metrics.memoryBytes),
                  cpu: metrics.cpuPercent.toFixed(1),
                })
              : undefined
          }
        >
          <Activity className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <span className="whitespace-nowrap">
            {t("statusbar.performance")}
            {metrics ? ` ${formatMb(metrics.memoryBytes)} MB` : ""}
          </span>
        </span>

        <span className="text-text-disabled">·</span>

        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("statusbar.zoomOut")}
            title={t("statusbar.zoomOut")}
            className={iconButton}
            onClick={() => changeZoom(zoomPct - ZOOM_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("statusbar.resetZoom")}
            title={t("statusbar.resetZoom")}
            className="min-w-9 cursor-pointer rounded text-center transition-colors hover:text-text-secondary"
            onClick={() => changeZoom(100)}
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            aria-label={t("statusbar.zoomIn")}
            title={t("statusbar.zoomIn")}
            className={iconButton}
            onClick={() => changeZoom(zoomPct + ZOOM_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </span>

        <span className="text-text-disabled">·</span>

        <button
          type="button"
          aria-label={t("statusbar.syncNow")}
          title={t("statusbar.syncNow")}
          disabled={syncing}
          className={cx(iconButton, syncing && "cursor-default opacity-60")}
          onClick={triggerSync}
        >
          <RefreshCw className={cx("size-3.5", syncing && "animate-spin")} aria-hidden />
        </button>

        {sync && (
          <>
            <span className="text-text-disabled">·</span>
            <span
              className={cx(
                "whitespace-nowrap",
                sync.finished ? "text-text-tertiary" : "text-notification-success-foreground",
              )}
            >
              {sync.finished
                ? t("statusbar.synced")
                : t("statusbar.syncing", { pct: syncPct, done: sync.done, total: sync.total })}
            </span>
          </>
        )}
        {version && (
          <>
            <span className="text-text-disabled">·</span>
            <span className="shrink-0">v{version}</span>
          </>
        )}
      </div>
    </div>
  );
}
