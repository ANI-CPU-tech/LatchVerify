import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ART_COLORS, landscape, type ArtTime } from "../../web/src/art/landscape.js";
import { THEMES } from "../../web/src/lib/themes.js";

const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");

describe.each(["day", "night"] as ArtTime[])("landscape by %s", (time) => {
  const art = landscape(time);

  it("is deterministic", () => {
    expect(landscape(time)).toEqual(art);
  });

  it("stays inside its canvas, one non-overlapping run per pixel", () => {
    const seen = new Set<string>();
    for (const run of art.runs) {
      expect(run.w).toBeGreaterThan(0);
      expect(run.x).toBeGreaterThanOrEqual(0);
      expect(run.x + run.w).toBeLessThanOrEqual(art.width);
      expect(run.y).toBeGreaterThanOrEqual(0);
      expect(run.y).toBeLessThan(art.height);
      for (let x = run.x; x < run.x + run.w; x++) {
        const key = `${x},${run.y}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  it("leaves the sky transparent and fills the bottom row", () => {
    expect(art.runs.some((run) => run.y === 0)).toBe(false);
    const bottom = art.runs.filter((run) => run.y === art.height - 1).reduce((n, run) => n + run.w, 0);
    expect(bottom).toBe(art.width);
  });
});

describe("day and night", () => {
  const count = (time: ArtTime, color: string, maxY = 96) =>
    landscape(time).runs.filter((run) => run.color === color && run.y < maxY).reduce((n, run) => n + run.w, 0);

  it("by day, uses every art color", () => {
    expect(new Set(landscape().runs.map((run) => run.color))).toEqual(new Set(ART_COLORS));
  });

  it("swaps the sun for a moon and stars at night, keeping the cabin window lit", () => {
    expect(count("day", "sun")).toBeGreaterThan(300);
    // Only the window stays sun-colored at night.
    expect(count("night", "sun")).toBeGreaterThan(0);
    expect(count("night", "sun")).toBeLessThan(15);
    // Moon and stars fill sky rows where the day has nothing pale.
    expect(count("day", "snow", 18)).toBe(0);
    expect(count("night", "snow", 18)).toBeGreaterThan(40);
    expect(count("night", "bird")).toBe(0);
  });
});

describe("art tokens", () => {
  it("every theme colors every part of the landscape", () => {
    for (const { id } of THEMES) {
      const block = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      for (const color of ART_COLORS) expect(block, `${id} --art-${color}`).toMatch(new RegExp(`--art-${color}:\\s*\\d`));
    }
  });
});
