import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Subscribe through one of the listen helpers in `@/lib/events`; the
 * returned teardown unlistens. Also covers the race where teardown runs
 * before the listen promise resolves: the late unlistener is invoked
 * immediately instead of leaking.
 */
export function subscribeTauriEvent(subscribe: () => Promise<UnlistenFn>): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  void subscribe().then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Component-lifetime subscription to a Tauri event: subscribes once on
 * mount, always unlistens on unmount. The latest `subscribe` closure is
 * used, so inline arrows capturing stable state setters are fine.
 */
export function useTauriEvent(subscribe: () => Promise<UnlistenFn>): void {
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  useEffect(() => subscribeTauriEvent(() => subscribeRef.current()), []);
}
