import { SEGMENTS, SPLASH_STORAGE_KEY, nextSegment } from "../lib/splash.js";

const TICK_MS = 85;
/** How long the shackle takes to drop and the screen to fade (site/src/styles/main.css). */
const LOCK_MS = 420;
const FADE_MS = 320;

/**
 * The loading screen. The inline script in <head> sets html.splash-on on a tab's first visit; this
 * fills the bar as the page loads, locks the padlock, fades the screen out and removes it.
 */
export function initSplash(): void {
  const root = document.documentElement;
  const splash = document.getElementById("splash");
  if (!splash || !root.classList.contains("splash-on")) {
    splash?.remove();
    return;
  }
  const fill = splash.querySelector<HTMLElement>(".splash-fill");
  const started = performance.now();
  let loaded = document.readyState === "complete";
  if (!loaded) window.addEventListener("load", () => (loaded = true), { once: true });

  let segment = 0;
  const timer = window.setInterval(() => {
    segment = nextSegment(segment, loaded, performance.now() - started);
    fill?.style.setProperty("--fill", String(segment / SEGMENTS));
    if (segment < SEGMENTS) return;
    window.clearInterval(timer);
    splash.classList.add("is-locked");
    window.setTimeout(() => {
      splash.classList.add("is-leaving");
      window.setTimeout(() => {
        splash.remove();
        root.classList.remove("splash-on");
      }, FADE_MS);
    }, LOCK_MS);
    try {
      window.sessionStorage.setItem(SPLASH_STORAGE_KEY, "1");
    } catch {
      // Without storage the screen shows again next time; nothing else depends on it.
    }
  }, TICK_MS);
}
