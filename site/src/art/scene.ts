/**
 * The site's hero artwork: a fortified mountain pass at sunset (or by moonlight). A road runs
 * from a cottage on the left (the MCP client), through a gatehouse in the middle (the latch
 * proxy) to a signal tower on the right (the MCP server). Messages travel the road as small
 * envelopes; replies come back as parcels. Now and then a poisoned envelope reaches the gate,
 * the portcullis drops, and an error parcel goes back to the cottage instead.
 *
 * Pure data, deterministic, in the pixel-art style of the review app's landscape
 * (web/src/art/landscape.ts) but its own scene. Layers are painted in order; parts that move have
 * a layer of their own, which site/src/styles/art.css (ambient motion) and sceneStyles() in
 * ./motion.ts (the message timeline) animate by their .art-<layer> class. Colors are names that
 * resolve to --art-<name> theme tokens, so both site themes recolor it without new assets.
 */

export const SCENE_COLORS = [
  "glow",
  "sun",
  "cloud",
  "haze",
  "far",
  "far-shade",
  "snow",
  "snow-shade",
  "mid",
  "mid-shade",
  "meadow",
  "meadow-shade",
  "near",
  "tree",
  "bird",
  "stone",
  "stone-shade",
  "stone-dark",
  "road",
  "road-shade",
  "lamp",
  "flag",
  "msg",
  "msg-shade",
  "reply",
  "alert",
] as const;
export type SceneColor = (typeof SCENE_COLORS)[number];

export type SceneTime = "day" | "night";

/** Layers in paint order. A layer that is empty in a scene is left out. */
export const SCENE_LAYERS = [
  "stars-a",
  "stars-b",
  "stars-c",
  "sky",
  "clouds",
  "birds-a",
  "birds-b",
  "land",
  "smoke-a",
  "smoke-b",
  "buildings",
  "gate-inside",
  "msg-q1",
  "msg-q2",
  "msg-a1",
  "msg-a2",
  "msg-bad",
  "msg-err",
  "alarm",
  "portcullis",
  "gatehouse",
  "windows",
  "lamps-a",
  "lamps-b",
  "beacon",
  "flag-a",
  "flag-b",
  "front",
  "fireflies-a",
  "fireflies-b",
] as const;
export type SceneLayer = (typeof SCENE_LAYERS)[number];

export interface Run {
  x: number;
  y: number;
  w: number;
  color: SceneColor;
}

export interface Layer {
  name: SceneLayer;
  /** Horizontal runs of one color; no two runs of a layer share a pixel. */
  runs: Run[];
}

export interface Scene {
  width: number;
  height: number;
  layers: Layer[];
}

export const WIDTH = 480;
export const HEIGHT = 128;

/** Valley floor: the meadow starts here in the middle of the pass. */
const MEADOW = 92;
/** The road's rows, top and bottom inclusive. */
export const ROAD = { top: 103, bottom: 114 } as const;
/** Top rows of the two lanes: requests head right on the upper one, replies come back below. */
export const LANES = { request: 105, reply: 110 } as const;
/** Message sprites are this wide; their x is their left edge. */
export const MESSAGE_WIDTH = 6;
/** Where messages leave the cottage and reach the tower (their left edge at the door). */
export const COTTAGE_DOOR = 56;
export const TOWER_DOOR = 409;
/** The gatehouse: outer walls, the arch, and where a blocked envelope waits before it. */
export const GATE = { left: 212, right: 252, archLeft: 224, archRight: 240, archTop: 96, stop: 204 } as const;
/** How far the portcullis rises into the wall when open (it is clipped to the arch). */
export const PORTCULLIS_TRAVEL = ROAD.bottom - GATE.archTop + 1;

const SUN = { x: 322, y: 66, r: 12 };
const MOON = { x: 322, y: 30, r: 8 };
const COTTAGE = { x: 30, w: 34 };
const TOWER = { x: 400, w: 24, top: 36 };

/** 4x4 ordered dither thresholds, the pixel-art stand-in for a gradient. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dither = (x: number, y: number, density: number): boolean => BAYER[(y & 3) * 4 + (x & 3)]! < density * 16;

/** Integer hash to [0, 1). */
function hash(n: number, seed: number): number {
  let h = Math.imul(n ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [0, 1], three octaves. */
function noise(x: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  for (let octave = 0; octave < 3; octave++) {
    const f = x * 2 ** octave;
    const i = Math.floor(f);
    const t = (f - i) ** 2 * (3 - 2 * (f - i));
    sum += amp * (hash(i, seed + octave) * (1 - t) + hash(i + 1, seed + octave) * t);
    amp /= 2;
  }
  return sum / 0.875;
}

/** A range of peaks as [x, summit y, drop per pixel]; its ridge is the lowest envelope of the cones. */
type Peak = readonly [number, number, number];
const DISTANT: Peak[] = [[40, 40, 0.45], [150, 34, 0.5], [262, 44, 0.45], [372, 36, 0.5], [470, 42, 0.45]];
const FAR: Peak[] = [[18, 34, 0.7], [84, 24, 0.62], [168, 30, 0.7], [236, 42, 0.6], [298, 52, 0.55], [392, 26, 0.62], [452, 38, 0.7]];
/** Forested hills, high at both ends and falling into the pass where the gatehouse stands. */
const MID: Peak[] = [[-10, 58, 0.3], [96, 66, 0.32], [176, 80, 0.3], [300, 82, 0.3], [380, 68, 0.32], [500, 60, 0.3]];

const cone = (p: Peak, x: number): number => p[1] + Math.abs(x - p[0]) * p[2];
const ridge = (peaks: Peak[], x: number, seed: number, rough: number): number =>
  Math.round(Math.min(...peaks.map((p) => cone(p, x))) + (noise(x / 6, seed) - 0.5) * rough);

/** The peak a pixel's slope belongs to: the nearest summit whose cone covers it. */
function peakAt(peaks: Peak[], x: number, y: number): Peak {
  let best = peaks[0]!;
  for (const p of peaks) if (y >= cone(p, x) && Math.abs(x - p[0]) < Math.abs(x - best[0])) best = p;
  return best;
}

/** True on the face of a peak turned away from the light, with a dithered crest. */
function shaded(peak: Peak, x: number, y: number, seed: number): boolean {
  const away = peak[0] < SUN.x ? -1 : 1;
  const below = y - peak[1];
  const crest = peak[0] - away * below * 0.5 + (noise(y / 3, seed + peak[0]) - 0.5) * 4;
  const d = (x - crest) * away;
  return d > 1 || (d > -1 && (x + y) % 2 === 0);
}

type Grid = Array<SceneColor | null>;
type Paint = (x: number, y: number, color: SceneColor) => void;

export function scene(time: SceneTime = "day"): Scene {
  const night = time === "night";
  const grids = new Map<SceneLayer, Grid>();
  const on = (name: SceneLayer): Paint => {
    let grid = grids.get(name);
    if (!grid) grids.set(name, (grid = new Array<SceneColor | null>(WIDTH * HEIGHT).fill(null)));
    const target = grid;
    return (x, y, color) => {
      // Only whole pixels: a fractional coordinate would land in another row's slot.
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) target[y * WIDTH + x] = color;
    };
  };
  const rect = (paint: Paint, x0: number, y0: number, x1: number, y1: number, color: SceneColor) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(x, y, color);
  };

  sky(on, night);
  land(on);
  cottage(on, rect, night);
  tower(on, rect, night);
  gatehouse(on, rect, night);
  messages(on, rect);
  foreground(on, night);

  const layers = SCENE_LAYERS.filter((name) => grids.has(name)).map((name) => toLayer(name, grids.get(name)!));
  return { width: WIDTH, height: HEIGHT, layers: layers.filter((layer) => layer.runs.length > 0) };
}

type On = (name: SceneLayer) => Paint;
type Rect = (paint: Paint, x0: number, y0: number, x1: number, y1: number, color: SceneColor) => void;

function sky(on: On, night: boolean) {
  const paint = on("sky");
  if (night) {
    // Stars in three sets that twinkle out of step, thicker toward the top.
    for (let i = 0; i < 150; i++) {
      const star = on((["stars-a", "stars-b", "stars-c"] as const)[i % 3]!);
      const x = Math.floor(hash(i, 100) * WIDTH);
      const y = 1 + Math.floor(hash(i, 101) ** 1.5 * 60);
      const bright = hash(i, 102) > 0.88;
      star(x, y, bright || hash(i, 103) > 0.5 ? "snow" : "snow-shade");
      if (bright) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) star(x + dx, y + dy, "snow-shade");
    }
    // A cratered moon with a faint dithered halo.
    const craters: Array<[number, number, number]> = [[-3, -2, 2], [3, 2, 1.6], [-1, 4, 1.3]];
    for (let y = MOON.y - MOON.r - 5; y <= MOON.y + MOON.r + 5; y++) {
      for (let x = MOON.x - MOON.r - 5; x <= MOON.x + MOON.r + 5; x++) {
        const [dx, dy] = [x - MOON.x, y - MOON.y];
        const d = Math.hypot(dx, dy);
        if (d <= MOON.r) {
          const crater = craters.some(([cx, cy, r]) => (dx - cx) ** 2 + (dy - cy) ** 2 <= r * r);
          paint(x, y, crater || (dx + dy > MOON.r - 1 && (x + y) % 2 === 0) ? "snow-shade" : "snow");
        } else if (dither(x, y, (1 - (d - MOON.r) / 5) * 0.45)) paint(x, y, "snow-shade");
      }
    }
  } else {
    // Afterglow low over the pass, strongest around the sun.
    for (let x = 0; x < WIDTH; x++) {
      // Only above the snowy range: below its ridge the glow would be painted over.
      for (let y = 40, top = ridge(FAR, x, 1, 5); y < top; y++) {
        const density = Math.max(0, 1 - Math.abs(x - SUN.x) / 200) * Math.min(1, (y - 40) / 30) * 0.5;
        if (dither(x, y, density)) paint(x, y, "glow");
      }
    }
    for (let y = SUN.y - SUN.r - 6; y <= SUN.y + SUN.r + 6; y++) {
      for (let x = SUN.x - SUN.r - 6; x <= SUN.x + SUN.r + 6; x++) {
        const d = Math.hypot(x - SUN.x, y - SUN.y);
        if (d <= SUN.r) paint(x, y, "sun");
        else if (d <= SUN.r + 1 || dither(x, y, 1 - (d - SUN.r) / 6)) paint(x, y, "glow");
      }
    }
    // Two flocks in two wing poses, shown in turn to flap.
    const wings = [
      [[-2, 0], [2, 0], [-1, 1], [1, 1], [0, 1]],
      [[-2, 1], [-1, 0], [0, 0], [1, 0], [2, 1]],
    ] as const;
    const flock: Array<[number, number]> = [[118, 22], [126, 18], [134, 23], [110, 26], [145, 16]];
    flock.forEach(([bx, by], i) => {
      for (const [layer, pose] of [["birds-a", i], ["birds-b", i + 1]] as const) {
        for (const [dx, dy] of wings[pose % 2]!) on(layer)(bx + dx, by + dy, "bird");
      }
    });
  }

  // Thin stratus streaks with frayed ends, in front of the sun and behind the peaks.
  const clouds = on("clouds");
  const streaks: Array<[number, number, number]> = [[268, 48, 64], [336, 58, 44], [60, 30, 56], [190, 20, 40], [410, 26, 50]];
  for (const [cx, cy, w] of streaks) {
    for (const [dy, from, to] of [[0, 0.3, 0.75], [1, 0, 1], [2, 0.2, 0.6]] as const) {
      const a = cx + Math.round(w * from + hash(cy + dy, cx) * 5);
      const b = cx + Math.round(w * to - hash(cy + dy, cx + 1) * 5);
      for (let x = a; x <= b; x++) clouds(x, cy + dy, night ? "snow-shade" : "cloud");
    }
  }
}

function land(on: On) {
  const paint = on("land");
  for (let x = 0; x < WIDTH; x++) for (let y = ridge(DISTANT, x, 3, 3); y < MEADOW; y++) paint(x, y, "haze");

  // Snowy far range: lit and shaded faces, snow above a ragged line.
  for (let x = 0; x < WIDTH; x++) {
    const top = ridge(FAR, x, 1, 5);
    const snow = 40 + (noise(x / 3, 7) - 0.5) * 14;
    for (let y = top; y < MEADOW; y++) {
      const shade = shaded(peakAt(FAR, x, y), x, y, 5);
      if (y < snow) paint(x, y, shade ? "snow-shade" : "snow");
      else paint(x, y, shade && !dither(x, y, (y - 60) / 32) ? "far-shade" : "far");
    }
  }

  // Forested hills falling into the pass, with a fringe of treetops and darker clumps.
  for (let x = 0; x < WIDTH; x++) {
    const top = ridge(MID, x, 2, 3);
    const fringe = hash(x, 11) > 0.82 ? 2 : hash(x, 11) > 0.5 ? 1 : 0;
    for (let y = top - fringe; y < MEADOW; y++) {
      const clump = hash(x * 977 + y, 12) > 0.86;
      const at = Math.max(y, top);
      paint(x, y, shaded(peakAt(MID, x, at), x, at, 9) || clump ? "mid-shade" : "mid");
    }
  }

  // The meadow on the valley floor, speckled, darker toward the viewer. Below the road the
  // foreground covers it.
  for (let y = MEADOW; y <= ROAD.bottom + 1; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const shade = hash(x * 131 + y, 20) > 0.82 || dither(x, y, (y - MEADOW) / 60);
      paint(x, y, shade ? "meadow-shade" : "meadow");
    }
  }

  // The road: worn edges, ruts along each lane, scattered stones.
  for (let x = 0; x < WIDTH; x++) {
    for (let y = ROAD.top; y <= ROAD.bottom; y++) {
      const edge = y === ROAD.top || y === ROAD.bottom;
      if (edge && hash(x, 30 + y) > 0.55) continue;
      const rut = (y === LANES.request + 4 || y === ROAD.top + 1) && hash(x, 31) > 0.7;
      paint(x, y, rut || hash(x * 53 + y, 32) > 0.93 ? "road-shade" : "road");
    }
  }

  // Stone walls climbing from the gatehouse along the hills on both sides: courses of brick with
  // a crenellated top. They stand on the road's back edge.
  for (const [from, to, dir] of [[132, GATE.left - 1, -1], [GATE.right + 1, 340, 1]] as const) {
    for (let x = from; x <= to; x++) {
      const along = dir < 0 ? GATE.left - x : x - GATE.right;
      const top = 89 - Math.round(along * 0.07);
      const merlon = Math.floor(x / 3) % 2 === 0;
      for (let y = top - (merlon ? 2 : 0); y < ROAD.top; y++) {
        const course = y - top;
        const joint = course % 3 === 2 || (x + (Math.floor(course / 3) % 2) * 3) % 6 === 0;
        paint(x, y, y < top ? "stone" : joint ? "stone-shade" : "stone");
      }
      // The wall's shadow on the road's back edge.
      if (hash(x, 33) > 0.3) paint(x, ROAD.top, "road-shade");
    }
  }
}

/** The client's cottage: timber walls, a slate roof, a lit window, a door on the road, a chimney. */
function cottage(on: On, rect: Rect, night: boolean) {
  const b = on("buildings");
  const { x, w } = COTTAGE;
  const base = ROAD.top - 1;
  for (let dy = 0; dy < 12; dy++) for (let dx = 0; dx < w; dx++) b(x + dx, base - dy, dy % 3 === 2 ? "far-shade" : "far");
  // Roof: overhangs the walls, narrows to a ridge.
  for (let r = 0; r < 8; r++) {
    for (let dx = -2 + r; dx <= w + 1 - r; dx++) b(x + dx, base - 12 - r, r === 7 ? "stone" : r % 2 ? "near" : "tree");
  }
  // Chimney, and smoke in two copies so one can rise and fade while the other takes over.
  const chimney = x + 7;
  rect(b, chimney, base - 23, chimney + 2, base - 16, "stone-dark");
  for (let n = 0; n < 12; n++) {
    const puff = on(n < 6 ? "smoke-a" : "smoke-b");
    const i = n % 6;
    const [px, py, r] = [chimney + 1 - i * 2, base - 26 - i * 3, 1 + i * 0.4];
    for (let yy = Math.floor(py - r); yy <= py + r; yy++) {
      for (let xx = Math.floor(px - r); xx <= px + r; xx++) {
        if ((xx - px) ** 2 + (yy - py) ** 2 <= r * r && dither(xx, yy, 0.95 - i * 0.13)) puff(xx, yy, "cloud");
      }
    }
  }
  // Door where the messages leave, and a window that glows.
  rect(b, COTTAGE_DOOR, base - 8, COTTAGE_DOOR + 5, base, "tree");
  b(COTTAGE_DOOR + 4, base - 4, "stone");
  const win = on("windows");
  rect(b, x + 5, base - 8, x + 12, base - 3, "tree");
  rect(win, x + 6, base - 7, x + 11, base - 4, night ? "lamp" : "glow");
  win(x + 8, base - 7, "tree");
  win(x + 8, base - 6, "tree");
  win(x + 8, base - 5, "tree");
  win(x + 8, base - 4, "tree");
  rect(win, x + 6, base - 6, x + 11, base - 6, "tree");
}

/** The server's signal tower: stone courses, arrow slits, a mast with a beacon. */
function tower(on: On, rect: Rect, night: boolean) {
  const b = on("buildings");
  const { x, w, top } = TOWER;
  const base = ROAD.top - 1;
  for (let y = top; y <= base; y++) {
    for (let dx = 0; dx < w; dx++) {
      const course = y - top;
      const joint = course % 4 === 3 || (dx + (Math.floor(course / 4) % 2) * 4) % 8 === 0;
      // The side away from the sun is in shadow.
      const shade = dx >= w - 6 || (dx >= w - 8 && (dx + y) % 2 === 0);
      b(x + dx, y, joint ? "stone-dark" : shade ? "stone-shade" : "stone");
    }
  }
  // Battlements overhanging the top.
  rect(b, x - 2, top - 2, x + w + 1, top - 1, "stone-shade");
  for (let dx = -2; dx <= w + 1; dx += 4) rect(b, x + dx, top - 5, x + dx + 1, top - 3, "stone-shade");
  // Mast and its beacon.
  rect(b, x + 11, top - 16, x + 12, top - 6, "tree");
  rect(on("beacon"), x + 10, top - 19, x + 13, top - 17, "lamp");
  // Door at the road and lit slits.
  rect(b, TOWER_DOOR, base - 9, TOWER_DOOR + 6, base, "tree");
  rect(b, TOWER_DOOR + 1, base - 10, TOWER_DOOR + 5, base - 10, "tree");
  const win = on("windows");
  for (const y of [top + 8, top + 22, top + 36]) rect(win, x + 9, y, x + 10, y + 4, night ? "lamp" : "stone-dark");
}

/** The latch: a gatehouse across the road with two towers, an arch, a portcullis and torches. */
function gatehouse(on: On, rect: Rect, night: boolean) {
  const g = on("gatehouse");
  const inside = on("gate-inside");
  const { left, right, archLeft, archRight, archTop } = GATE;
  const base = ROAD.bottom;
  const inArch = (x: number, y: number) => {
    if (x < archLeft || x > archRight || y > base) return false;
    // Rounded top: the corners of the opening step in.
    const fromSide = Math.min(x - archLeft, archRight - x);
    return y >= archTop + Math.max(0, 3 - fromSide);
  };
  const towers: Array<[number, number]> = [[left, left + 11], [right - 11, right]];
  for (let y = 62; y <= base; y++) {
    for (let x: number = left; x <= right; x++) {
      const inTower = towers.some(([a, b]) => x >= a && x <= b);
      if (!inTower && y < 74) continue;
      if (inArch(x, y)) {
        inside(x, y, y >= ROAD.top ? "stone-dark" : "tree");
        continue;
      }
      const course = y - 62;
      const joint = course % 4 === 3 || (x + (Math.floor(course / 4) % 2) * 3) % 6 === 0;
      const shade = (inTower && x > towers[1]![0] + 6) || (!inTower && y > 90 && x > archRight);
      g(x, y, joint ? "stone-dark" : shade ? "stone-shade" : "stone");
    }
  }
  // Crenellations on both towers and the curtain between them.
  for (const [a, b] of towers) for (let x = a; x <= b; x += 4) rect(g, x, 59, Math.min(x + 1, b), 61, "stone");
  for (let x = left + 13; x < right - 12; x += 4) rect(g, x, 72, x + 1, 73, "stone-shade");
  // Arrow slits.
  for (const [a] of towers) rect(g, a + 5, 70, a + 6, 76, "tree");
  // The padlock emblem over the arch.
  const cx = (archLeft + archRight) / 2;
  rect(g, cx - 3, 82, cx + 3, 88, "stone-dark");
  rect(g, cx - 2, 83, cx + 2, 87, "flag");
  rect(g, cx - 2, 79, cx - 2, 82, "stone-dark");
  rect(g, cx + 2, 79, cx + 2, 82, "stone-dark");
  rect(g, cx - 1, 78, cx + 1, 78, "stone-dark");
  g(cx, 85, "stone-dark");
  g(cx, 86, "stone-dark");
  // Portcullis, drawn closed; motion.ts raises it into the wall (clipped to the arch).
  const bars = on("portcullis");
  for (let y: number = archTop; y <= base; y++) {
    for (let x: number = archLeft; x <= archRight; x++) {
      if (!inArch(x, y)) continue;
      const bar = (x - archLeft) % 3 === 1 || (y - archTop) % 4 === 2;
      if (bar) bars(x, y, (y - archTop) % 4 === 2 ? "stone-dark" : "tree");
      if (y === base && (x - archLeft) % 3 === 1) bars(x, y, "stone");
    }
  }
  // Torches either side of the arch, in two flames that alternate, with a steady dithered glow at night.
  for (const tx of [archLeft - 4, archRight + 4]) {
    rect(g, tx, 94, tx, 97, "tree");
    on("lamps-a")(tx, 92, "lamp");
    on("lamps-a")(tx, 93, "sun");
    on("lamps-b")(tx, 93, "lamp");
    on("lamps-b")(tx - 1, 92, "sun");
    if (night) {
      for (let y = 88; y <= 99; y++) {
        for (let x = tx - 5; x <= tx + 5; x++) {
          const d = Math.hypot(x - tx, y - 93);
          if (d > 1.5 && d < 6 && dither(x, y, (1 - d / 6) * 0.35) && !inArch(x, y)) on("windows")(x, y, "lamp");
        }
      }
    }
  }
  // A pennant on the left tower in two poses.
  const pole = left + 3;
  rect(g, pole, 48, pole, 58, "tree");
  const poses: Array<[SceneLayer, number[]]> = [
    ["flag-a", [0, 0, 1, 1, 1, 2, 2]],
    ["flag-b", [0, 1, 1, 0, 0, 1, 1]],
  ];
  for (const [layer, waves] of poses) {
    waves.forEach((dy, i) => {
      const length = 4 - Math.floor(i / 2);
      for (let r = 0; r < Math.max(1, length); r++) on(layer)(pole + 1 + i, 48 + dy + r, r === 0 && i > 2 ? "sun" : "flag");
    });
  }
}

/**
 * Message sprites, each drawn at the start of its trip; motion.ts moves them. Requests are
 * envelopes, replies are tied parcels; the poisoned envelope carries a red seal and the error
 * reply is a red parcel.
 */
function messages(on: On, rect: Rect) {
  const envelope = (paint: Paint, x: number, y: number, seal: boolean) => {
    rect(paint, x, y, x + 5, y + 3, "msg");
    for (const [dx, dy] of [[0, 0], [5, 0], [1, 1], [4, 1], [2, 2], [3, 2]] as const) paint(x + dx, y + dy, "msg-shade");
    if (seal) rect(paint, x + 2, y + 2, x + 3, y + 3, "alert");
  };
  const parcel = (paint: Paint, x: number, y: number, color: SceneColor) => {
    rect(paint, x, y, x + 5, y + 3, color);
    rect(paint, x + 2, y, x + 2, y + 3, "msg-shade");
    rect(paint, x, y + 1, x + 5, y + 1, "msg-shade");
  };
  envelope(on("msg-q1"), COTTAGE_DOOR, LANES.request, false);
  envelope(on("msg-q2"), COTTAGE_DOOR, LANES.request, false);
  parcel(on("msg-a1"), TOWER_DOOR, LANES.reply, "reply");
  parcel(on("msg-a2"), TOWER_DOOR, LANES.reply, "reply");
  envelope(on("msg-bad"), COTTAGE_DOOR, LANES.request, true);
  parcel(on("msg-err"), GATE.stop, LANES.reply, "alert");
  // An exclamation mark over the stopped envelope, drawn where it stops.
  const alarm = on("alarm");
  rect(alarm, GATE.stop + 2, LANES.request - 8, GATE.stop + 3, LANES.request - 5, "alert");
  rect(alarm, GATE.stop + 2, LANES.request - 3, GATE.stop + 3, LANES.request - 3, "alert");
}

/** Grass below the road, bushes along its edge and pines framing both sides. */
function foreground(on: On, night: boolean) {
  const front = on("front");
  for (let x = 0; x < WIDTH; x++) {
    // Tufts on the road's front edge, except where the gatehouse stands on it.
    const tufts = x < GATE.left || x > GATE.right;
    if (tufts && hash(x, 70) > 0.55) front(x, ROAD.bottom + 1, "near");
    for (let y = ROAD.bottom + 2; y < HEIGHT; y++) front(x, y, hash(x * 977 + y, 71) > 0.88 ? "tree" : "near");
    if (tufts && hash(x, 72) > 0.7) front(x, ROAD.bottom + 1 - (hash(x, 73) > 0.5 ? 1 : 0), "near");
  }
  // Pines: taller toward the edges of the scene.
  const pine = (cx: number, base: number, height: number) => {
    const h = Math.round(height);
    const lit = cx < SUN.x ? 1 : -1;
    for (let r = 0; r < h - 1; r++) {
      const half = Math.floor(r * 0.22 + (r % 4) * 0.35);
      const left = half + (hash(r, cx * 7) > 0.75 ? 1 : 0);
      const right = half + (hash(r, cx * 7 + 1) > 0.75 ? 1 : 0);
      for (let dx = -left; dx <= right; dx++) {
        const edge = dx === (lit > 0 ? right : -left);
        front(cx + dx, base - h + r, edge && half > 0 && r % 2 === 1 ? "near" : "tree");
      }
    }
    front(cx, base - 1, "tree");
  };
  for (let cx = -3; cx < 26; cx += 3 + Math.floor(hash(cx + 50, 50) * 3)) pine(cx, HEIGHT + 1, 30 + Math.round(hash(cx + 50, 51) * 14) - cx / 2);
  for (let cx = 446; cx < WIDTH + 4; cx += 3 + Math.floor(hash(cx, 52) * 3)) pine(cx, HEIGHT + 1, 26 + Math.round(hash(cx, 53) * 14) + (cx - 446) / 2);
  // Small pines behind the cottage and around the tower's foot.
  for (const [cx, h] of [[72, 16], [78, 12], [382, 14], [390, 18], [432, 15]] as const) pine(cx, ROAD.top, h);

  if (night) {
    // Fireflies among the pines, in two sets that blink out of step.
    for (let i = 0; i < 24; i++) {
      const paint = on(i % 2 ? "fireflies-b" : "fireflies-a");
      const x = i < 12 ? 4 + Math.floor(hash(i, 300) * 80) : 380 + Math.floor(hash(i, 300) * 96);
      const y = 84 + Math.floor(hash(i, 301) * 38);
      paint(x, y, "lamp");
    }
  }
}

/** A grid of pixels as horizontal runs of one color. */
function toLayer(name: SceneLayer, grid: Grid): Layer {
  const runs: Run[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    let x = 0;
    while (x < WIDTH) {
      const color = grid[y * WIDTH + x];
      let end = x + 1;
      while (end < WIDTH && grid[y * WIDTH + end] === color) end++;
      if (color) runs.push({ x, y, w: end - x, color });
      x = end;
    }
  }
  return { name, runs };
}
