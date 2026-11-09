import { THEME_COLORS, readTheme, resolveTheme, writeTheme, type Theme } from "../lib/theme.js";

/** The page's localStorage, or undefined where reading it throws (blocked site data). */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The theme switch in the header. The inline script in <head> has already applied the saved or
 * system theme; this keeps the switch's label in step, saves a choice, and follows the system
 * setting for visitors who have not made one.
 */
export function initTheme(reducedMotion: boolean): void {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")];
  const current = (): Theme => (root.dataset.theme === "dark" ? "dark" : "light");

  const apply = (theme: Theme) => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
    const next = theme === "dark" ? "light" : "dark";
    for (const button of buttons) button.setAttribute("aria-label", `Switch to ${next} theme`);
  };
  apply(resolveTheme(readTheme(storage()), matchMedia("(prefers-color-scheme: dark)").matches));

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const next: Theme = current() === "dark" ? "light" : "dark";
      writeTheme(storage(), next);
      // A cross-fade of the whole page: the art and the screenshots swap rather than recolor.
      if (!reducedMotion && typeof document.startViewTransition === "function") document.startViewTransition(() => apply(next));
      else apply(next);
    });
  }

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (readTheme(storage()) === null) apply(event.matches ? "dark" : "light");
  });
}
