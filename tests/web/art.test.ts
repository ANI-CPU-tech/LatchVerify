import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ART_COLORS, landscape } from "../../web/src/art/landscape.js";
import { THEMES } from "../../web/src/lib/themes.js";

const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");

describe("landscape", () => {
  const art = landscape();

  it("is deterministic", () => {
    expect(landscape()).toEqual(art);
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

  it("draws the sun, clouds, both ranges with their shading, snow, lake, pines and birds", () => {
    expect(new Set(art.runs.map((run) => run.color))).toEqual(new Set(ART_COLORS));
  });

  it("leaves the sky transparent and fills the bottom row", () => {
    expect(art.runs.some((run) => run.y === 0)).toBe(false);
    const bottom = art.runs.filter((run) => run.y === art.height - 1).reduce((n, run) => n + run.w, 0);
    expect(bottom).toBe(art.width);
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
