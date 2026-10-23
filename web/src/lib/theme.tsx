import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { THEME_STORAGE_KEY, parsePreference, readPreference, resolveTheme, writePreference, type ThemeId, type ThemePreference } from "./themes";

const DARK_QUERY = "(prefers-color-scheme: dark)";

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
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Applies the theme to <html> and keeps it in step with the OS setting and other tabs. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference(safeStorage()));
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false);
  const theme = resolveTheme(preference, prefersDark);

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
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    return { saved: writePreference(safeStorage(), next) };
  };

  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
