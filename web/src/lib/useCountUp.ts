import { useEffect, useRef, useState } from "react";
import { countFrame } from "./motion";

/** How long a number takes to count to a new value. */
export const COUNT_MS = 700;

const prefersReducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * `value`, counting up (or down) to each new value from the one on screen, from 0 the first time.
 * Null passes straight through, and without motion the value shows at once.
 */
export function useCountUp(value: number | null): number | null {
  const [shown, setShown] = useState<number | null>(value === null || prefersReducedMotion() ? value : 0);
  const current = useRef(shown);
  current.current = shown;

  useEffect(() => {
    if (value === null || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const from = current.current ?? 0;
    if (from === value) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const next = countFrame(from, value, now - start, COUNT_MS);
      setShown(next);
      if (next !== value) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return shown;
}
