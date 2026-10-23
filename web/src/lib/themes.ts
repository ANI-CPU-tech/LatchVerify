import type { ArtExtra, ArtTime } from "../art/landscape.js";

/**
 * Theme registry. Each id has a token block in src/index.css; this file only names them.
 * A theme changes colors, never behaviour: nothing here is read by review or approval code.
 */
export const THEMES = [
  { id: "light", label: "Default Light", description: "Cream, off-white, orange", dark: false, art: "balloon" },
  { id: "warm", label: "Warm Retro", description: "Ivory, muted orange, brown", dark: false, art: "sailboat" },
  { id: "sunset", label: "Sunset", description: "Apricot, burnt orange", dark: false, art: "geese" },
  { id: "terminal", label: "Terminal Dark", description: "Charcoal, cream text, orange", dark: true, art: "fireflies" },
  { id: "minimal", label: "Minimal", description: "Neutral, muted artwork", dark: false, art: "snowfall" },
  { id: "forest", label: "Forest Green", description: "Ivory, forest green, olive", dark: false, art: null },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string; dark: boolean; art: ArtExtra | null }>;

export type ThemeId = (typeof THEMES)[number]["id"];

/** A theme, or "system": Default Light or Terminal Dark following the OS setting. */
export type ThemePreference = ThemeId | "system";

export const DEFAULT_PREFERENCE: ThemePreference = "light";
export const SYSTEM_THEMES = { light: "light", dark: "terminal" } as const satisfies Record<string, ThemeId>;

/** localStorage key. index.html reads it too, to set the theme before first paint. */
export const THEME_STORAGE_KEY = "latch.theme";

const THEME_IDS: ReadonlySet<string> = new Set(THEMES.map((theme) => theme.id));

/** Dark themes (color-scheme: dark in index.css) show the landscape at night. */
export const isDarkTheme = (id: ThemeId): boolean => THEMES.some((theme) => theme.id === id && theme.dark);

/** The landscape a theme shows: night for dark themes, plus the theme's own extra. */
export function sceneFor(id: ThemeId): { time: ArtTime; extra: ArtExtra | null } {
  const theme = THEMES.find((entry) => entry.id === id)!;
  return { time: theme.dark ? "night" : "day", extra: theme.art };
}

export const isThemeId = (value: unknown): value is ThemeId => typeof value === "string" && THEME_IDS.has(value);

/** A stored value as a preference; anything unknown (old, edited, missing) is the default. */
export function parsePreference(raw: unknown): ThemePreference {
  return raw === "system" || isThemeId(raw) ? raw : DEFAULT_PREFERENCE;
}

/** The theme a preference shows, given whether the OS prefers dark. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeId {
  if (preference !== "system") return preference;
  return prefersDark ? SYSTEM_THEMES.dark : SYSTEM_THEMES.light;
}

/** The saved preference. Storage can be missing or throw (private mode, blocked site data). */
export function readPreference(storage: Pick<Storage, "getItem"> | undefined): ThemePreference {
  try {
    return parsePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** Saves the preference; returns false when the browser would not store it (it still applies). */
export function writePreference(storage: Pick<Storage, "setItem"> | undefined, preference: ThemePreference): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}
