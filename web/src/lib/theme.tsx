import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { SURFACE_STORAGE_KEY, parseSurface, readSurface, writeSurface } from "./surface";
import { THEME_STORAGE_KEY, parsePreference, readPreference, resolveTheme, writePreference, type ThemeId, type ThemePreference } from "./themes";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const prefersReducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
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

  /**
   * Applies at once. A change the viewer picks cross-fades the whole page with the View Transition
   * API: a snapshot of the old theme fades into the new one, sky gradient and artwork included,
   * which per-property CSS transitions cannot do (gradients do not transition and the day and
   * night art are different elements). Without the API, or with reduced motion, it switches at once.
   */
  const setPreference = (next: ThemePreference) => {
    const saved = writePreference(safeStorage(), next);
    const nextTheme = resolveTheme(next, prefersDark);
    const apply = () => {
      flushSync(() => setPreferenceState(next));
      document.documentElement.setAttribute("data-theme", nextTheme);
    };
    if (nextTheme !== theme && typeof document.startViewTransition === "function" && !prefersReducedMotion()) {
      document.startViewTransition(apply);
    } else {
      apply();
    }
    return { saved };
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
