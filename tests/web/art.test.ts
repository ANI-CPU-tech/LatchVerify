import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ART_COLORS, ART_EXTRAS, ART_LAYERS, landscape, starrySky, type ArtTime, type PixelArt } from "../../web/src/art/landscape.js";
import { THEMES } from "../../web/src/lib/themes.js";

const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");

const allRuns = (art: PixelArt) => art.layers.flatMap((layer) => layer.runs);

/** Pixels of one color, across every layer, above row maxY. */
const count = (art: PixelArt, color: string, maxY = Infinity) =>
  allRuns(art)
    .filter((run) => run.color === color && run.y < maxY)
    .reduce((n, run) => n + run.w, 0);

describe.each(["day", "night"] as ArtTime[])("landscape by %s", (time) => {
  const art = landscape(time);

  it("is deterministic", () => {
    expect(landscape(time)).toEqual(art);
  });

  it("paints known layers in order, none of them empty", () => {
    const names = art.layers.map((layer) => layer.name);
    expect(names).toEqual(ART_LAYERS.filter((name) => names.includes(name)));
    for (const layer of art.layers) expect(layer.runs.length, layer.name).toBeGreaterThan(0);
  });

  it("keeps every layer inside its canvas, one run per pixel within a layer", () => {
    for (const layer of art.layers) {
      const seen = new Set<string>();
      for (const run of layer.runs) {
        expect(run.w).toBeGreaterThan(0);
        expect(run.x).toBeGreaterThanOrEqual(0);
        expect(run.x + run.w).toBeLessThanOrEqual(art.width);
        expect(run.y).toBeGreaterThanOrEqual(0);
        expect(run.y).toBeLessThan(art.height);
        for (let x = run.x; x < run.x + run.w; x++) {
          const key = `${x},${run.y}`;
          expect(seen.has(key), `${layer.name} ${key}`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("leaves the top row transparent and the land fills the bottom row", () => {
    expect(allRuns(art).some((run) => run.y === 0)).toBe(false);
    const land = art.layers.find((layer) => layer.name === "land")!;
    const bottom = land.runs.filter((run) => run.y === art.height - 1).reduce((n, run) => n + run.w, 0);
    expect(bottom).toBe(art.width);
  });
});

describe("day and night", () => {
  it("by day, uses every art color", () => {
    expect(new Set(allRuns(landscape()).map((run) => run.color))).toEqual(new Set(ART_COLORS));
  });

  it("swaps the sun for a moon and stars at night, keeping the cabin window lit", () => {
    const [day, night] = [landscape("day"), landscape("night")];
    expect(count(day, "sun")).toBeGreaterThan(300);
    // Only the window stays sun-colored at night.
    expect(count(night, "sun")).toBeGreaterThan(0);
    expect(count(night, "sun")).toBeLessThan(15);
    // Moon and stars fill sky rows where the day has nothing pale.
    expect(count(day, "snow", 18)).toBe(0);
    expect(count(night, "snow", 18)).toBeGreaterThan(40);
    expect(count(night, "bird")).toBe(0);
  });

  it("draws each moving part in its own layer, in two copies or poses where it alternates", () => {
    const names = (art: PixelArt) => art.layers.map((layer) => layer.name);
    expect(names(landscape("day"))).toEqual(expect.arrayContaining(["clouds", "glint-a", "glint-b", "smoke-a", "smoke-b", "birds-a", "birds-b"]));
    expect(names(landscape("night"))).toEqual(expect.arrayContaining(["stars-a", "stars-b", "stars-c", "glint-a", "glint-b", "window"]));
  });
});

describe.each(ART_EXTRAS.flatMap((extra) => (["day", "night"] as ArtTime[]).map((time) => [extra, time] as const)))("extra %s by %s", (extra, time) => {
  const art = landscape(time, extra);
  const base = landscape(time);

  it("only adds layers to the shared scene, inside the canvas and below the top row", () => {
    const names = art.layers.map((layer) => layer.name);
    expect(names).toEqual(ART_LAYERS.filter((name) => names.includes(name)));
    expect(names.length).toBeGreaterThan(base.layers.length);
    for (const layer of base.layers) expect(art.layers).toContainEqual(layer);
    for (const run of allRuns(art)) {
      expect(run.x + run.w).toBeLessThanOrEqual(art.width);
      expect(run.y).toBeGreaterThan(0);
      expect(run.y).toBeLessThan(art.height);
    }
  });
});

describe("starry sky", () => {
  const sky = starrySky();

  it("is deterministic, as wide as the landscape, and only stars inside its canvas", () => {
    expect(starrySky()).toEqual(sky);
    expect(sky.width).toBe(landscape().width);
    for (const run of allRuns(sky)) {
      expect(["snow", "snow-shade"]).toContain(run.color);
      expect(run.x + run.w).toBeLessThanOrEqual(sky.width);
      expect(run.y).toBeLessThan(sky.height);
    }
    expect(allRuns(sky).length).toBeGreaterThan(300);
  });
});

describe("art tokens and styles", () => {
  it("every theme colors every part of the landscape", () => {
    for (const { id } of THEMES) {
      const block = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      for (const color of ART_COLORS) expect(block, `${id} --art-${color}`).toMatch(new RegExp(`--art-${color}:\\s*\\d`));
    }
  });

  it("gives every theme its own extra, and every extra to a theme", () => {
    expect(THEMES.map((theme) => theme.art).sort()).toEqual([...ART_EXTRAS].sort());
  });

  it("styles only layers that exist", () => {
    const styled = new Set([...css.matchAll(/\.art-([a-z-]+)/g)].map((match) => match[1]!));
    for (const name of styled) expect(ART_LAYERS, `.art-${name}`).toContain(name);
  });
});
