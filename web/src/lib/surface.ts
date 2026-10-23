/**
 * Card opacity preference. Cards over the landscape are see-through by the theme's
 * --surface-alpha, the lowest opacity that keeps every text color at AA contrast over any art
 * color (tests/web/themes.test.ts). The preference moves them from there toward solid:
 * 0 is as see-through as the theme allows, 1 is solid. It can never go below the theme's floor,
 * so no setting makes text unreadable.
 */

/** localStorage key. Every access is wrapped: storage can be missing or throw. */
export const SURFACE_STORAGE_KEY = "latch.surface";

export const DEFAULT_SURFACE = 0;

/** Slider granularity: 5% steps. */
export const SURFACE_STEP = 0.05;

/** A stored or entered value as a preference in [0, 1] on SURFACE_STEP; anything else is the default. */
export function parseSurface(raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_SURFACE;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped / SURFACE_STEP) * SURFACE_STEP;
}

/** The card opacity a preference gives on a theme whose floor is `min`. */
export function surfaceAlpha(min: number, surface: number): number {
  return min + parseSurface(surface) * (1 - min);
}

/** The saved preference, or the default when there is none or storage is unavailable. */
export function readSurface(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    return parseSurface(storage?.getItem(SURFACE_STORAGE_KEY));
  } catch {
    return DEFAULT_SURFACE;
  }
}

/** Saves the preference; returns false when the browser would not store it (it still applies). */
export function writeSurface(storage: Pick<Storage, "setItem"> | undefined, surface: number): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SURFACE_STORAGE_KEY, String(parseSurface(surface)));
    return true;
  } catch {
    return false;
  }
}
