import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SURFACE_STORAGE_KEY, parseSurface, readSurface, writeSurface } from "./surface";
import { THEME_STORAGE_KEY, parsePreference, readPreference, resolveTheme, writePreference, type ThemeId, type ThemePreference } from "./themes";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** How long colors cross-fade when the theme changes. */
const THEME_FADE_MS = 400;

const safeStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

interface ThemeContextValue {
  preference: ThemePreference;
  /** The theme on screen: the preference, or what "system" resolves to. */
  theme: ThemeId;
  /** Applies at once; `saved` is false when the browser would not store it. */
  setPreference: (preference: ThemePreference) => { saved: boolean };
  /** Card opacity, 0 (as see-through as the theme allows) to 1 (solid); see lib/surface.ts. */
  surface: number;
  setSurface: (surface: number) => { saved: boolean };
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Applies the theme to <html> and keeps it in step with the OS setting and other tabs. Also
 * applies the card opacity preference as --surface-mix on <html>.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference(safeStorage()));
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false);
  const theme = resolveTheme(preference, prefersDark);
  const [surface, setSurfaceState] = useState(() => readSurface(safeStorage()));

  useEffect(() => {
    document.documentElement.style.setProperty("--surface-mix", String(surface));
  }, [surface]);

  // On a theme change (not the first paint), cross-fade colors: index.css transitions colors on
  // everything under html.theme-switching for THEME_FADE_MS, motion-safe only.
  const appliedTheme = useRef<ThemeId | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const switching = appliedTheme.current !== null && appliedTheme.current !== theme;
    appliedTheme.current = theme;
    if (!switching) {
      root.setAttribute("data-theme", theme);
      return;
    }
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", theme);
    const timer = window.setTimeout(() => root.classList.remove("theme-switching"), THEME_FADE_MS);
    return () => {
      window.clearTimeout(timer);
      root.classList.remove("theme-switching");
    };
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setPreferenceState(parsePreference(event.newValue));
      if (event.key === SURFACE_STORAGE_KEY) setSurfaceState(parseSurface(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    return { saved: writePreference(safeStorage(), next) };
  };

  const setSurface = (next: number) => {
    setSurfaceState(parseSurface(next));
    return { saved: writeSurface(safeStorage(), next) };
  };

  return <ThemeContext.Provider value={{ preference, theme, setPreference, surface, setSurface }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
