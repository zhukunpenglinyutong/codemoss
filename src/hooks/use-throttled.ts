import { useEffect, useRef, useState } from "react";

/**
 * Trailing-throttle a fast-changing value: immediate while idle, otherwise at
 * most one update per `ms`. Feeds expensive consumers (a full markdown
 * reparse is ~5ms/2KB and grows linearly) from per-frame streaming buffers
 * without burning the main thread on a reparse per delta.
 *
 * Shrinking values (e.g. the streaming buffer clearing on commit) pass
 * through immediately — a stale tail must never linger next to the row the
 * text was just committed into.
 */
export function useThrottled(value: string, ms: number): string {
  const [throttled, setThrottled] = useState(value);
  const lastEmit = useRef(0);
  useEffect(() => {
    if (value.length <= throttled.length) {
      lastEmit.current = Date.now();
      setThrottled(value);
      return;
    }
    const wait = ms - (Date.now() - lastEmit.current);
    if (wait <= 0) {
      lastEmit.current = Date.now();
      setThrottled(value);
      return;
    }
    const timer = setTimeout(() => {
      lastEmit.current = Date.now();
      setThrottled(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms, throttled.length]);
  return throttled;
}
