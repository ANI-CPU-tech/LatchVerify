/**
 * The loading screen's bar, in whole segments: it creeps toward SEGMENTS while the page loads,
 * stops short of full until the page has loaded and the screen has shown for a moment, then fills.
 * Pure, so tests/site/splash.test.ts can step it.
 */

export const SEGMENTS = 12;
/** The screen stays at least this long, so the padlock is seen rather than flashed. */
export const MIN_SHOW_MS = 900;
/** Past this, the bar fills whatever the page is doing: a slow image never holds the site back. */
export const MAX_WAIT_MS = 4000;
/** Shown once per browser tab: sessionStorage key, read by the inline script in each page's head too. */
export const SPLASH_STORAGE_KEY = "latchverify.site.splash";

/** The bar after one tick, from where it is, whether the page has loaded and the ms since it showed. */
export function nextSegment(segment: number, loaded: boolean, elapsed: number): number {
  if (segment >= SEGMENTS) return SEGMENTS;
  const ready = (loaded && elapsed >= MIN_SHOW_MS) || elapsed >= MAX_WAIT_MS;
  // Before then: up to three quarters while loading, one short of full once loaded.
  const cap = ready ? SEGMENTS : loaded ? SEGMENTS - 1 : Math.round(SEGMENTS * 0.75);
  return Math.min(segment + 1, cap);
}
