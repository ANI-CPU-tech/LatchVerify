import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS, iconPath, iconSvg } from "../../site/src/art/icons.js";
import { CYCLE, GATE_CLOSED, SPEED, TRIPS, inGate, sceneStyles, tripEnd } from "../../site/src/art/motion.js";
import { COTTAGE_DOOR, GATE, HEIGHT, LANES, ROAD, SCENE_COLORS, SCENE_LAYERS, TOWER_DOOR, WIDTH, scene } from "../../site/src/art/scene.js";
import { heroSvg } from "../../site/src/art/svg.js";

const tokens = readFileSync(new URL("../../site/src/styles/tokens.css", import.meta.url), "utf8");
const pixelsOf = (time: "day" | "night", name: string) => {
  const layer = scene(time).layers.find((l) => l.name === name);
  return (layer?.runs ?? []).flatMap((run) => Array.from({ length: run.w }, (_, i) => [run.x + i, run.y] as const));
};

describe("hero scene", () => {
  it("is the same every time it is drawn", () => {
    expect(JSON.stringify(scene("day"))).toBe(JSON.stringify(scene("day")));
    expect(JSON.stringify(scene("night"))).toBe(JSON.stringify(scene("night")));
  });

  it("stays on its canvas, in whole pixels, with runs that never overlap within a layer", () => {
    for (const time of ["day", "night"] as const) {
      for (const layer of scene(time).layers) {
        const seen = new Set<number>();
        for (const run of layer.runs) {
          expect(Number.isInteger(run.x) && Number.isInteger(run.y) && Number.isInteger(run.w), layer.name).toBe(true);
          expect(run.x >= 0 && run.x + run.w <= WIDTH && run.y >= 0 && run.y < HEIGHT, layer.name).toBe(true);
          for (let x = run.x; x < run.x + run.w; x++) {
            expect(seen.has(run.y * WIDTH + x), `${layer.name} ${x},${run.y}`).toBe(false);
            seen.add(run.y * WIDTH + x);
          }
        }
      }
    }
  });

  it("paints its layers in the registered order, and only registered colors", () => {
    for (const time of ["day", "night"] as const) {
      const names = scene(time).layers.map((layer) => layer.name);
      expect(names).toEqual(SCENE_LAYERS.filter((name) => names.includes(name)));
      for (const layer of scene(time).layers) for (const run of layer.runs) expect(SCENE_COLORS).toContain(run.color);
    }
  });

  it("has a theme token for every color, in both themes", () => {
    for (const theme of ["light", "dark"]) {
      const block = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(tokens)![1]!;
      for (const color of SCENE_COLORS) expect(block, `${theme} --art-${color}`).toMatch(new RegExp(`--art-${color}:\\s*\\d`));
    }
  });

  it("shows the sun by day, the moon, stars and fireflies by night", () => {
    const day = scene("day").layers.map((l) => l.name);
    const night = scene("night").layers.map((l) => l.name);
    expect(day).toContain("birds-a");
    expect(day).not.toContain("stars-a");
    expect(night).toEqual(expect.arrayContaining(["stars-a", "stars-b", "stars-c", "fireflies-a", "fireflies-b"]));
    expect(night).not.toContain("birds-a");
  });

  it("keeps the foreground clear of the gatehouse, so messages stay visible through the arch", () => {
    const front = pixelsOf("day", "front").filter(([x, y]) => x >= GATE.left && x <= GATE.right && y <= ROAD.bottom);
    expect(front).toEqual([]);
  });

  it("draws every message where its trip starts, on its lane", () => {
    for (const trip of TRIPS) {
      const pixels = pixelsOf("day", trip.layer);
      expect(pixels.length, trip.layer).toBeGreaterThan(0);
      expect(Math.min(...pixels.map(([x]) => x)), trip.layer).toBe(trip.from);
      const lane = trip.to > trip.from ? LANES.request : LANES.reply;
      if (trip.layer !== "msg-bad") expect(Math.min(...pixels.map(([, y]) => y)), trip.layer).toBe(lane);
    }
  });
});

describe("message timeline", () => {
  it("finishes every trip inside one loop", () => {
    for (const trip of TRIPS) {
      expect(trip.start, trip.layer).toBeGreaterThanOrEqual(0);
      expect(tripEnd(trip) + (trip.hold ?? 0), trip.layer).toBeLessThan(CYCLE);
    }
  });

  it("runs requests from the cottage to the tower and replies back", () => {
    for (const trip of TRIPS.filter((t) => t.layer.startsWith("msg-q"))) expect([trip.from, trip.to]).toEqual([COTTAGE_DOOR, TOWER_DOOR]);
    for (const trip of TRIPS.filter((t) => t.layer.startsWith("msg-a"))) expect([trip.from, trip.to]).toEqual([TOWER_DOOR, COTTAGE_DOOR]);
  });

  it("never lets a message through the gate while the portcullis is down", () => {
    // Margin for the drop and the rise of the portcullis.
    const [closedFrom, closedTo] = [GATE_CLOSED.from - 0.5, GATE_CLOSED.to + 0.5];
    for (const trip of TRIPS) {
      const span = inGate(trip);
      if (!span) continue;
      for (const offset of [0, CYCLE]) {
        const [from, to] = [span.from + offset, span.to + offset];
        expect(to < closedFrom || from > closedTo, `${trip.layer} in the gate from ${from}s to ${to}s`).toBe(true);
      }
    }
  });

  it("stops the poisoned envelope short of the gate, as the portcullis drops", () => {
    const bad = TRIPS.find((t) => t.layer === "msg-bad")!;
    expect(inGate(bad)).toBeNull();
    expect(bad.to).toBe(GATE.stop);
    expect(tripEnd(bad)).toBeCloseTo(GATE_CLOSED.from, 5);
    const err = TRIPS.find((t) => t.layer === "msg-err")!;
    expect(err.from).toBe(GATE.stop);
    expect(err.start).toBeGreaterThan(tripEnd(bad) + bad.hold!);
  });

  it("moves sprites one whole pixel per step", () => {
    const css = sceneStyles(".hero-art");
    for (const trip of TRIPS) expect(css).toContain(`steps(${Math.abs(trip.to - trip.from)}, end)`);
    expect(SPEED).toBeGreaterThan(0);
  });

  it("animates only for viewers who have not asked for less motion, and hides the sprites otherwise", () => {
    const css = sceneStyles(".hero-art");
    const [still, moving] = css.split("@media (prefers-reduced-motion: no-preference) {");
    expect(still).toContain("opacity: 0");
    expect(still).not.toContain("animation");
    expect(moving).toContain("animation: lv-msg-q1");
    expect(css).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("svg", () => {
  it("draws shared layers once and the rest in day and night copies", () => {
    const svg = heroSvg();
    expect(svg.match(/class="art-land"/g)).toHaveLength(1);
    expect(svg).toContain('class="art-sky art-day"');
    expect(svg).toContain('class="art-sky art-night"');
    expect(svg).toContain('class="art-stars-a art-night"');
    expect(svg).toContain('clip-path="url(#lv-arch)"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toMatch(/NaN|undefined/);
  });
});

describe("pixel icons", () => {
  it("are square bitmaps of 8 or 12 pixels", () => {
    for (const [name, rows] of Object.entries(ICONS)) {
      expect([8, 12], name).toContain(rows.length);
      for (const row of rows) expect(row, name).toMatch(new RegExp(`^[#.]{${rows.length}}$`));
      expect(rows.join("").includes("#"), name).toBe(true);
    }
  });

  it("render as decorative SVG paths in currentColor", () => {
    expect(iconPath(["#.#", "###"])).toBe("M0 0h1v1h-1zM2 0h1v1h-1zM0 1h3v1h-3z");
    const svg = iconSvg("lock", "extra");
    expect(svg).toContain('viewBox="0 0 12 12"');
    expect(svg).toContain('class="px-icon px-icon-lg extra"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('fill="currentColor"');
  });
});
