import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a timed "copied" flag for the button's success
 * state. The reset timer is restarted on a second copy and cleared on
 * unmount, so no setState lands after the component is gone.
 */
export function useCopied(resetMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        clearTimeout(timer.current);
        setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), resetMs);
      });
    },
    [resetMs],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { copied, copy };
}
