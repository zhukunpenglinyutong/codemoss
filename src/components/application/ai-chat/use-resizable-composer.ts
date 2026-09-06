import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentPropsWithoutRef,
  PointerEvent as ReactPointerEvent,
} from "react";

/**
 * useResizableComposer — pointer-driven vertical resize of the composer,
 * ported from desktop-cc-gui's useResizableChatInputBox:
 * - drag the top handle up/down to resize the input area (min..max bounds)
 * - drag below min − overshoot (held 400ms) collapses the composer
 * - drag up from collapsed (held 400ms) expands it again
 * - size persists in localStorage and clamps on window resize
 */

interface SizeState {
  /** Explicit editable-area height chosen by dragging; null = auto-grow. */
  wrapperHeightPx: number | null;
  isCollapsed: boolean;
}

interface Bounds {
  minWrapperHeightPx: number;
  maxWrapperHeightPx: number;
}

const STORAGE_KEY = "composer:size-v1";

const VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO = 0.55;
const MAX_WRAPPER_HEIGHT_CAP_PX = 520;
const MIN_MAX_WRAPPER_HEIGHT_PX = 140;
const DEFAULT_MIN_WRAPPER_HEIGHT_PX = 66;
const COLLAPSE_OVERSHOOT_PX = 36;
const EXPAND_DRAG_THRESHOLD_PX = 18;
const COLLAPSE_EXPAND_HOLD_MS = 400;
const EXPAND_RESIZE_HOLD_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getBounds(): Bounds {
  const viewportH =
    typeof window !== "undefined" ? window.innerHeight : VIEWPORT_HEIGHT_FALLBACK_PX;
  // Keep a sane cap so the input doesn't take over the UI.
  const maxWrapperHeightPx = Math.max(
    MIN_MAX_WRAPPER_HEIGHT_PX,
    Math.floor(
      Math.min(viewportH * MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO, MAX_WRAPPER_HEIGHT_CAP_PX),
    ),
  );
  return {
    minWrapperHeightPx: Math.min(DEFAULT_MIN_WRAPPER_HEIGHT_PX, maxWrapperHeightPx),
    maxWrapperHeightPx,
  };
}

function readInitialSize(): SizeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      let wrapperHeightPx =
        typeof obj.wrapperHeightPx === "number" && Number.isFinite(obj.wrapperHeightPx)
          ? obj.wrapperHeightPx
          : null;
      if (wrapperHeightPx !== null && wrapperHeightPx < DEFAULT_MIN_WRAPPER_HEIGHT_PX) {
        wrapperHeightPx = null;
      }
      return { wrapperHeightPx, isCollapsed: obj.isCollapsed === true };
    }
  } catch {
    // fall through to default size
  }
  return { wrapperHeightPx: null, isCollapsed: false };
}

function computeResize(
  start: { startY: number; startWrapperHeightPx: number },
  current: { y: number },
  bounds: Bounds,
): { wrapperHeightPx: number } {
  const dy = current.y - start.startY;
  // Dragging up (dy < 0) increases height.
  return {
    wrapperHeightPx: clamp(
      Math.round(start.startWrapperHeightPx - dy),
      bounds.minWrapperHeightPx,
      bounds.maxWrapperHeightPx,
    ),
  };
}

export function useResizableComposer({
  editableRef,
}: {
  editableRef: React.RefObject<HTMLElement | null>;
}): {
  isResizing: boolean;
  isCollapsed: boolean;
  /** Explicit editable-area height; null = auto-grow layout. */
  manualHeightPx: number | null;
  getHandleProps: () => ComponentPropsWithoutRef<"div">;
  nudge: (delta: { wrapperHeightPx?: number }) => void;
} {
  const [size, setSize] = useState<SizeState>(readInitialSize);
  const sizeRef = useRef<SizeState>(size);
  sizeRef.current = size;

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<{
    startY: number;
    startWrapperHeightPx: number;
    bounds: Bounds;
    prevUserSelect: string;
    prevCursor: string;
    startCollapsed: boolean;
    expandResizeUnlocked: boolean;
  } | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const pendingTransitionRef = useRef<"collapse" | "expand" | null>(null);
  const expandResizeTimerRef = useRef<number | null>(null);
  const pendingExpandResizeRef = useRef(false);
  const latestPointerYRef = useRef<number | null>(null);

  const clearPendingTransition = useCallback(() => {
    if (transitionTimerRef.current != null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    pendingTransitionRef.current = null;
  }, []);

  const clearPendingExpandResizeUnlock = useCallback(() => {
    if (expandResizeTimerRef.current != null) {
      window.clearTimeout(expandResizeTimerRef.current);
      expandResizeTimerRef.current = null;
    }
    pendingExpandResizeRef.current = false;
  }, []);

  const scheduleExpandResizeUnlock = useCallback(() => {
    if (pendingExpandResizeRef.current) return;

    pendingExpandResizeRef.current = true;
    expandResizeTimerRef.current = window.setTimeout(() => {
      expandResizeTimerRef.current = null;
      pendingExpandResizeRef.current = false;

      const start = startRef.current;
      if (!start) return;

      start.expandResizeUnlocked = true;

      const pointerY = latestPointerYRef.current ?? start.startY;
      const { wrapperHeightPx } = computeResize(
        {
          startY: start.startY,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { y: pointerY },
        start.bounds,
      );

      setSize({ wrapperHeightPx, isCollapsed: false });
    }, EXPAND_RESIZE_HOLD_MS);
  }, []);

  const applyTransition = useCallback(
    (intent: "collapse" | "expand") => {
      const start = startRef.current;
      const pointerY = start ? (latestPointerYRef.current ?? start.startY) : null;

      if (intent === "collapse") {
        if (start && pointerY != null) {
          start.startCollapsed = true;
          start.startY = pointerY;
          start.startWrapperHeightPx = start.bounds.minWrapperHeightPx;
          start.expandResizeUnlocked = true;
        }
        clearPendingExpandResizeUnlock();
        setSize((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }));
        return;
      }

      if (!start || pointerY == null) return;

      start.startCollapsed = false;
      start.startY = pointerY;
      start.startWrapperHeightPx = start.bounds.minWrapperHeightPx;
      start.expandResizeUnlocked = false;
      clearPendingExpandResizeUnlock();

      setSize({
        wrapperHeightPx: start.bounds.minWrapperHeightPx,
        isCollapsed: false,
      });
    },
    [clearPendingExpandResizeUnlock],
  );

  const scheduleTransition = useCallback(
    (next: "collapse" | "expand" | null) => {
      if (pendingTransitionRef.current === next) return;

      if (transitionTimerRef.current != null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }

      pendingTransitionRef.current = next;
      if (!next) return;

      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null;
        if (pendingTransitionRef.current !== next) return;
        applyTransition(next);
      }, COLLAPSE_EXPAND_HOLD_MS);
    },
    [applyTransition],
  );

  // Persist size changes (best-effort).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      // ignore
    }
  }, [size]);

  // Clamp persisted size on window resize (e.g. user shrinks the window).
  useEffect(() => {
    const onResize = () => {
      const bounds = getBounds();
      setSize((prev) => {
        const nextWrapperHeightPx =
          prev.wrapperHeightPx == null
            ? null
            : clamp(
                prev.wrapperHeightPx,
                bounds.minWrapperHeightPx,
                bounds.maxWrapperHeightPx,
              );
        if (nextWrapperHeightPx === prev.wrapperHeightPx) return prev;
        return { ...prev, wrapperHeightPx: nextWrapperHeightPx };
      });
    };

    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const currentHeightPx = useCallback(() => {
    const bounds = getBounds();
    const measured = editableRef.current?.getBoundingClientRect().height;
    return sizeRef.current.wrapperHeightPx ?? Math.round(measured ?? bounds.minWrapperHeightPx);
  }, [editableRef]);

  const nudge = useCallback(
    (delta: { wrapperHeightPx?: number }) => {
      const bounds = getBounds();
      const currentHeight = currentHeightPx();

      if (sizeRef.current.isCollapsed) {
        if ((delta.wrapperHeightPx ?? 0) <= 0) return;
        const baseHeight = clamp(
          currentHeight,
          bounds.minWrapperHeightPx,
          bounds.maxWrapperHeightPx,
        );
        const nextHeight = clamp(
          Math.round(baseHeight + (delta.wrapperHeightPx ?? 0)),
          bounds.minWrapperHeightPx,
          bounds.maxWrapperHeightPx,
        );
        setSize({ wrapperHeightPx: nextHeight, isCollapsed: false });
        return;
      }

      const nextHeight =
        delta.wrapperHeightPx == null
          ? currentHeight
          : clamp(
              Math.round(currentHeight + delta.wrapperHeightPx),
              bounds.minWrapperHeightPx,
              bounds.maxWrapperHeightPx,
            );

      if (
        delta.wrapperHeightPx != null &&
        delta.wrapperHeightPx < 0 &&
        currentHeight <= bounds.minWrapperHeightPx
      ) {
        setSize((prev) => ({ ...prev, isCollapsed: true }));
        return;
      }

      setSize((prev) => ({
        ...prev,
        isCollapsed: false,
        wrapperHeightPx: delta.wrapperHeightPx == null ? prev.wrapperHeightPx : nextHeight,
      }));
    },
    [currentHeightPx],
  );

  const stopResize = useCallback(() => {
    const start = startRef.current;
    if (!start) return;

    document.body.style.userSelect = start.prevUserSelect;
    document.body.style.cursor = start.prevCursor;

    clearPendingTransition();
    clearPendingExpandResizeUnlock();
    latestPointerYRef.current = null;
    startRef.current = null;
    setIsResizing(false);
  }, [clearPendingExpandResizeUnlock, clearPendingTransition]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      e.preventDefault();
      const dy = e.clientY - start.startY;
      latestPointerYRef.current = e.clientY;

      if (start.startCollapsed) {
        const shouldExpand = dy <= -EXPAND_DRAG_THRESHOLD_PX;
        if (!shouldExpand) {
          scheduleTransition(null);
          setSize((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }));
          return;
        }
        scheduleTransition("expand");
        return;
      }

      if (!start.expandResizeUnlocked) {
        const shouldUnlockResize = dy <= -EXPAND_DRAG_THRESHOLD_PX;
        if (shouldUnlockResize) {
          scheduleExpandResizeUnlock();
        } else {
          clearPendingExpandResizeUnlock();
        }

        setSize({
          wrapperHeightPx: start.bounds.minWrapperHeightPx,
          isCollapsed: false,
        });
        return;
      }

      const rawHeight = start.startWrapperHeightPx - dy;
      const shouldCollapse = rawHeight <= start.bounds.minWrapperHeightPx - COLLAPSE_OVERSHOOT_PX;

      if (shouldCollapse) {
        clearPendingExpandResizeUnlock();
        scheduleTransition("collapse");
        return;
      }

      scheduleTransition(null);
      clearPendingExpandResizeUnlock();
      const { wrapperHeightPx } = computeResize(
        {
          startY: start.startY,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { y: e.clientY },
        start.bounds,
      );

      setSize({ wrapperHeightPx, isCollapsed: false });
    };

    const onUp = () => stopResize();
    const onCancel = () => stopResize();

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [clearPendingExpandResizeUnlock, scheduleExpandResizeUnlock, scheduleTransition, stopResize]);

  useEffect(() => {
    return () => {
      clearPendingTransition();
      clearPendingExpandResizeUnlock();
    };
  }, [clearPendingExpandResizeUnlock, clearPendingTransition]);

  const getHandleProps = useCallback((): ComponentPropsWithoutRef<"div"> => {
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        const bounds = getBounds();
        const measured = editableRef.current?.getBoundingClientRect().height;
        const startWrapperHeightPx =
          sizeRef.current.wrapperHeightPx ??
          (measured ? Math.round(measured) : bounds.minWrapperHeightPx);

        const prevUserSelect = document.body.style.userSelect;
        const prevCursor = document.body.style.cursor;

        document.body.style.userSelect = "none";
        document.body.style.cursor = "ns-resize";
        clearPendingTransition();
        clearPendingExpandResizeUnlock();
        latestPointerYRef.current = e.clientY;

        startRef.current = {
          startY: e.clientY,
          startWrapperHeightPx,
          bounds,
          prevUserSelect,
          prevCursor,
          startCollapsed: sizeRef.current.isCollapsed,
          expandResizeUnlocked: !sizeRef.current.isCollapsed,
        };

        setIsResizing(true);
      },
    };
  }, [clearPendingExpandResizeUnlock, clearPendingTransition, editableRef]);

  const manualHeightPx = useMemo(
    () => (size.isCollapsed ? null : size.wrapperHeightPx),
    [size.isCollapsed, size.wrapperHeightPx],
  );

  return {
    isResizing,
    isCollapsed: size.isCollapsed,
    manualHeightPx,
    getHandleProps,
    nudge,
  };
}
