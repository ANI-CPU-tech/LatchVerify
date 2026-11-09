/**
 * The site's two themes. The visitor's choice is kept in localStorage; without one, the site
 * follows the system setting. The inline script in each page's <head> applies the same rule
 * before first paint; tests/site/html.test.ts keeps the two in step.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "latchverify.site.theme";

/** The browser's theme-color for each theme: its --background token as hex. */
export const THEME_COLORS: Readonly<Record<Theme, string>> = { light: "#f7f0e4", dark: "#1a1714" };

export const parseTheme = (raw: unknown): Theme | null => (raw === "light" || raw === "dark" ? raw : null);

export const resolveTheme = (stored: Theme | null, prefersDark: boolean): Theme => stored ?? (prefersDark ? "dark" : "light");

/** The saved choice; storage can be missing or throw (private mode, blocked site data). */
export function readTheme(storage: Pick<Storage, "getItem"> | undefined): Theme | null {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Saves the choice; returns false when the browser would not store it (it still applies). */
export function writeTheme(storage: Pick<Storage, "setItem"> | undefined, theme: Theme): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
