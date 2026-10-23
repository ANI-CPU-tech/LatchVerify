import { useEffect, useState, type ReactNode } from "react";
import { pageChange } from "../lib/nav";

/** Milliseconds the old page takes to fade out; the new one then fades in over the same time. */
export const PAGE_FADE_MS = 160;

const prefersReducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Fades the old page out and the new one in when `pageKey` changes. Changes within a page (another
 * change selected, fresh data) show at once. Opacity only: a transform would make this wrapper
 * the containing block of anything fixed inside a page. Without motion the swap is instant.
 */
export function PageTransition({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  const [shown, setShown] = useState({ key: pageKey, content: children });
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const change = pageChange(shown.key, pageKey, prefersReducedMotion());
    if (change === "stay") {
      // Also reached by going back to the shown page before its fade-out finished: cancel the fade,
      // or the page would stay invisible.
      setLeaving(false);
      setShown((current) => (current.content === children ? current : { key: pageKey, content: children }));
      return;
    }
    if (change === "swap") {
      setShown({ key: pageKey, content: children });
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown({ key: pageKey, content: children });
      setLeaving(false);
    }, PAGE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [pageKey, children, shown.key]);

  return (
    <div
      className={`space-y-6 transition-opacity ease-out motion-reduce:transition-none ${leaving ? "opacity-0" : "opacity-100"}`}
      style={{ transitionDuration: `${PAGE_FADE_MS}ms` }}
    >
      {shown.content}
    </div>
  );
}
