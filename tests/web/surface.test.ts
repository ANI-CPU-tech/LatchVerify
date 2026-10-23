import { describe, expect, it } from "vitest";
import { DEFAULT_SURFACE, SURFACE_STORAGE_KEY, parseSurface, readSurface, surfaceAlpha, writeSurface } from "../../web/src/lib/surface.js";

describe("parseSurface", () => {
  it.each([
    [0, 0],
    [1, 1],
    ["0.5", 0.5],
    [0.52, 0.5],
    [0.53, 0.55],
    [-1, 0],
    [7, 1],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseSurface(raw)).toBeCloseTo(expected, 10);
  });

  it.each([null, undefined, "", "  ", "abc", Number.NaN, Infinity, {}, "1e999"])("falls back to the default for %j", (raw) => {
    expect(parseSurface(raw)).toBe(DEFAULT_SURFACE);
  });
});

describe("surfaceAlpha", () => {
  it("runs from the theme's floor to solid and never below the floor", () => {
    expect(surfaceAlpha(0.9, 0)).toBe(0.9);
    expect(surfaceAlpha(0.9, 1)).toBe(1);
    expect(surfaceAlpha(0.8, 0.5)).toBeCloseTo(0.9, 10);
    expect(surfaceAlpha(0.8, -3)).toBe(0.8);
  });
});

describe("readSurface and writeSurface", () => {
  const memory = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
  };

  it("round-trips through storage on the step grid", () => {
    const storage = memory();
    expect(writeSurface(storage, 0.73)).toBe(true);
    expect(storage.map.get(SURFACE_STORAGE_KEY)).toBe("0.75");
    expect(readSurface(storage)).toBeCloseTo(0.75, 10);
  });

  it("uses the default when storage is missing, empty or throws", () => {
    expect(readSurface(undefined)).toBe(DEFAULT_SURFACE);
    expect(readSurface(memory())).toBe(DEFAULT_SURFACE);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readSurface(broken)).toBe(DEFAULT_SURFACE);
    expect(writeSurface(broken, 0.5)).toBe(false);
    expect(writeSurface(undefined, 0.5)).toBe(false);
  });
});
