"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * React Aria's `Popover` couples "non-modal" with "not dismissable on
 * outside interaction" — `isNonModal` (which we set to avoid the scroll
 * lock / focus trap that comes with a modal popover) also silently disables
 * its built-in outside-click-to-close behavior. This restores just that
 * piece manually: closes when a pointerdown lands outside every given ref
 * (typically the trigger + the popover's own content).
 */
export function useDismissOnOutsidePress(
  isOpen: boolean,
  onDismiss: () => void,
  refs: RefObject<HTMLElement | null>[],
) {
  // Call sites pass fresh `() => setIsOpen(false)` closures and fresh
  // `[triggerRef, popoverRef]` arrays every render — keep the latest values
  // in a ref so the listener below attaches/detaches only when `isOpen`
  // actually changes, not on every render while open.
  const latestRef = useRef({ onDismiss, refs });
  latestRef.current = { onDismiss, refs };

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const { onDismiss, refs } = latestRef.current;
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen]);
}

/**
 * Companion fix for the same `isNonModal` popovers: pressing the trigger
 * while the popover is open should close it (toggle), but React Aria fires
 * `onOpenChange(false)` immediately followed by `onOpenChange(true)` within
 * the same press, so the popover never actually closes.
 *
 * This watches for a pointerdown on the trigger while open and swallows the
 * spurious reopen that follows. Wire the returned guard into the component's
 * `onOpenChange`:
 *
 *   const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
 *   <AriaSelect onOpenChange={(o) => allowOpenChange(o) && setIsOpen(o)} …
 */
export function useTriggerToggle(
  isOpen: boolean,
  triggerRef: RefObject<HTMLElement | null>,
) {
  const suppressReopenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) return;
      suppressReopenRef.current = true;
      // Safety valve: only the very next open within this click may be
      // swallowed; never leave a stale suppression behind.
      setTimeout(() => {
        suppressReopenRef.current = false;
      }, 400);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen, triggerRef]);

  return (next: boolean) => {
    if (next && suppressReopenRef.current) {
      suppressReopenRef.current = false;
      return false;
    }
    return true;
  };
}

/**
 * The five-piece boilerplate every non-modal popover in the app repeats:
 * open state, trigger + popover refs, outside-press dismissal, and the
 * trigger-press toggle guard (see the two hooks above). `setOpen` is the
 * guarded setter to hand to `AriaDialogTrigger.onOpenChange` — it returns
 * false when the change was a spurious reopen that got swallowed, so call
 * sites with side effects on open/close can bail out early.
 */
export function usePopoverState() {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);

  const close = () => setIsOpen(false);
  const toggle = () => setIsOpen((open) => !open);

  useDismissOnOutsidePress(isOpen, close, [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);

  const setOpen = (next: boolean): boolean => {
    if (!allowOpenChange(next)) return false;
    setIsOpen(next);
    return true;
  };

  return { isOpen, triggerRef, popoverRef, toggle, close, setOpen };
}
