/**
 * Original pixel-art landscape: a sun setting behind snowy peaks, forested hills, a lake that
 * mirrors them and pine shores in front. Built from a few shapes and seeded noise, so it is
 * deterministic and stays crisp at any size. Pure data: the React component (PixelLandscape.tsx)
 * paints each color with a theme token (--art-*), so every theme recolors it without new assets.
 */

export const ART_COLORS = [
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
  "water",
  "near",
  "tree",
  "bird",
] as const;
export type ArtColor = (typeof ART_COLORS)[number];

export interface PixelArt {
  width: number;
  height: number;
  /** Horizontal runs of one color; no two runs share a pixel. */
  runs: Array<{ x: number; y: number; w: number; color: ArtColor }>;
}

const WIDTH = 512;
const HEIGHT = 96;
/** Near the middle, so narrow screens (which crop the sides) still show it. */
const SUN = { x: 300, y: 50, r: 15 };
/** Water line of the lake: below it is water unless the shore covers it. */
const LAKE = 74;
/** Snow covers the peaks above this row, give or take the noise of the gullies. */
const SNOW_LINE = 35;

/** Peaks as [x, summit y, drop per pixel]; a range's ridge is the lowest envelope of its peaks. */
type Peak = [number, number, number];
/** Hazy range far behind the snowy one, seen only through its valleys. */
const DISTANT: Peak[] = [[60, 34, 0.5], [165, 30, 0.45], [232, 38, 0.5], [340, 40, 0.45], [450, 32, 0.5]];
const FAR: Peak[] = [[30, 30, 0.7], [88, 20, 0.6], [140, 34, 0.75], [196, 24, 0.65], [250, 42, 0.7], [305, 54, 0.5], [360, 38, 0.7], [418, 18, 0.6], [480, 30, 0.7]];
const MID: Peak[] = [[10, 58, 0.35], [70, 50, 0.4], [150, 56, 0.35], [215, 52, 0.4], [400, 54, 0.4], [462, 48, 0.35], [520, 58, 0.4]];
/** Foreground shore as [x, y] points; below the canvas means open water. */
const SHORE: Array<[number, number]> = [[0, 70], [60, 75], [130, 83], [185, 91], [215, 100], [380, 100], [410, 90], [460, 79], [512, 72]];
/** Stratus streaks as [x, y, width]; drawn in front of the sun, behind the peaks. */
const CLOUDS: Array<[number, number, number]> = [[262, 42, 70], [318, 54, 50], [118, 26, 60], [398, 30, 46], [40, 22, 40]];
/** Log cabin on the left shore: left edge and width. */
const CABIN = { x: 144, w: 17 };
/** Jetty from the cabin into the lake: planks from x to x + w on row y. */
const JETTY = { x: 166, w: 46, y: 90 };
/** Rocks in the shallows as [x, width, height], resting on the bottom row. */
const ROCKS: Array<[number, number, number]> = [[222, 7, 3], [231, 4, 2], [362, 6, 3]];
/** Waterline of the canoe's hull, on the edge of the sun's glitter path. */
const CANOE = { x: 284, y: 86 };
const BIRDS: Array<[number, number]> = [[176, 30], [186, 26], [195, 31], [168, 34], [206, 24]];
/** A second flock, far off and tiny. */
const FAR_BIRDS: Array<[number, number]> = [[104, 12], [109, 10], [113, 14], [118, 11]];
/** Wing poses as pixel offsets: raised, level, lowered. Each bird of the flock takes the next. */
const WINGS = [
  [[-2, 0], [2, 0], [-1, 1], [1, 1], [0, 1]],
  [[-2, 0], [-1, 0], [0, 1], [1, 0], [2, 0]],
  [[-2, 1], [-1, 0], [0, 0], [1, 0], [2, 1]],
] as const;

/** 4x4 ordered-dither thresholds, the pixel-art stand-in for a gradient. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dither = (x: number, y: number, density: number) => BAYER[(y & 3) * 4 + (x & 3)]! < density * 16;

/** Integer hash to [0, 1). */
function hash(n: number, seed: number): number {
  let h = Math.imul(n ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [0, 1], four octaves. */
function fbm(x: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  for (let octave = 0; octave < 4; octave++) {
    const f = x * 2 ** octave;
    const i = Math.floor(f);
    const t = (f - i) ** 2 * (3 - 2 * (f - i));
    sum += amp * (hash(i, seed + octave) * (1 - t) + hash(i + 1, seed + octave) * t);
    amp /= 2;
  }
  return sum / 0.9375;
}

const cone = (p: Peak, x: number) => p[1] + Math.abs(x - p[0]) * p[2];

/** Ridge y at column x. */
function ridge(peaks: Peak[], x: number, seed: number, rough: number): number {
  return Math.round(Math.min(...peaks.map((p) => cone(p, x))) + (fbm(x / 6, seed) - 0.5) * rough);
}

/**
 * The peak whose surface a pixel is on: lower peaks stand in front of higher ones, so faces meet
 * along the slopes of the front peaks, not as vertical seams under each valley.
 */
function ownerAt(peaks: Peak[], x: number, y: number): Peak {
  let owner: Peak | undefined;
  let nearest = peaks[0]!;
  for (const p of peaks) {
    if (y >= cone(p, x) && (!owner || p[1] > owner[1])) owner = p;
    if (cone(p, x) < cone(nearest, x)) nearest = p;
  }
  // Ridge noise can lift a pixel above every cone; it then belongs to the one forming the ridge.
  return owner ?? nearest;
}

/**
 * True on the face of a peak turned away from the sun (the crest between faces is dithered),
 * and in the gullies of the sunlit face.
 */
function shaded(peak: Peak, x: number, y: number): boolean {
  const away = peak[0] < SUN.x ? -1 : 1;
  const below = y - peak[1];
  // The crest runs down from the summit toward the sunlit side, wandering a little.
  const crest = peak[0] - away * below * 0.55 + (fbm(y / 3, peak[0]) - 0.5) * 5;
  const d = (x - crest) * away;
  if (d > 1 || (d > -1 && (x + y) % 2 === 0)) return true;
  // Gullies follow the fall line of the face and thin out toward its foot.
  return fbm((x + away * below * 0.6) / 2, peak[0] + 1) > 0.58 + below / 80;
}

function shoreAt(x: number): number {
  for (let i = 1; i < SHORE.length; i++) {
    const [x0, y0] = SHORE[i - 1]!;
    const [x1, y1] = SHORE[i]!;
    if (x <= x1) return Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) + (fbm(x / 6, 40) - 0.5) * 4);
  }
  return SHORE[SHORE.length - 1]![1];
}

export function landscape(): PixelArt {
  const grid: Array<ArtColor | null> = new Array(WIDTH * HEIGHT).fill(null);
  const get = (x: number, y: number) => (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT ? grid[y * WIDTH + x]! : null);
  const set = (x: number, y: number, color: ArtColor) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) grid[y * WIDTH + x] = color;
  };

  // Afterglow low on the horizon, fading with height and distance from the sun.
  for (let y = 36; y < LAKE; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const density = Math.max(0, 1 - Math.abs(x - SUN.x) / 190) * Math.min(1, (y - 36) / 34) * 0.55;
      if (dither(x, y, density)) set(x, y, "glow");
    }
  }

  // Sun with a dithered halo. Distances are squared until the halo needs the real one.
  for (let y = SUN.y - SUN.r - 7; y <= SUN.y + SUN.r + 7; y++) {
    for (let x = SUN.x - SUN.r - 7; x <= SUN.x + SUN.r + 7; x++) {
      const d = (x - SUN.x) ** 2 + (y - SUN.y) ** 2;
      if (d <= SUN.r ** 2) set(x, y, "sun");
      else if (d <= (SUN.r + 1) ** 2 || dither(x, y, 1 - (Math.sqrt(d) - SUN.r) / 7)) set(x, y, "glow");
    }
  }

  // Clouds: a long streak with shorter ones above and below, frayed ends.
  for (const [cx, cy, w] of CLOUDS) {
    for (const [dy, from, to] of [[0, 0.25, 0.7], [1, 0, 1], [2, 0.15, 0.55]] as const) {
      const a = cx + Math.round(w * from + hash(cy + dy, cx) * 6);
      const b = cx + Math.round(w * to - hash(cy + dy, cx + 1) * 6);
      for (let x = a; x <= b; x++) set(x, cy + dy, "cloud");
    }
  }

  for (let x = 0; x < WIDTH; x++) {
    for (let y = ridge(DISTANT, x, 3, 3); y < LAKE; y++) set(x, y, "haze");
  }

  // Far range: sunlit and shadowed faces, snow above the snow line reaching down the gullies.
  for (let x = 0; x < WIDTH; x++) {
    const top = ridge(FAR, x, 1, 5);
    const snow = SNOW_LINE + (fbm(x / 3, 7) - 0.5) * 16;
    for (let y = top; y < LAKE; y++) {
      const shade = shaded(ownerAt(FAR, x, y), x, y);
      if (y < snow) set(x, y, shade ? "snow-shade" : "snow");
      // Haze lightens the shadows toward the valley floor.
      else set(x, y, shade && !dither(x, y, (y - 58) / 30) ? "far-shade" : "far");
    }
  }

  // Mid range: forested hills, a fringe of distant treetops on the ridge and darker clumps.
  for (let x = 0; x < WIDTH; x++) {
    const top = ridge(MID, x, 2, 3);
    const fringe = hash(x, 11) > 0.85 ? 2 : hash(x, 11) > 0.55 ? 1 : 0;
    for (let y = top - fringe; y < LAKE; y++) {
      const clump = hash(x * 977 + y, 12) > 0.88;
      const at = Math.max(y, top);
      set(x, y, shaded(ownerAt(MID, x, at), x, at) || clump ? "mid-shade" : "mid");
    }
  }

  // Lake: a mirror of the ranges broken by ripples that thicken toward the viewer, and the
  // sun's glitter path.
  for (let y = LAKE; y < HEIGHT; y++) {
    const depth = y - LAKE;
    const shift = Math.round((fbm(y * 0.7, 21) - 0.5) * 6);
    for (let x = 0; x < WIDTH; x++) {
      const ripple = fbm(x / 10, 60 + y) < 0.25 + depth * 0.012;
      const above = ripple ? null : get(x + shift, LAKE - 1 - depth);
      let color: ArtColor = "water";
      if (above === "far" || above === "far-shade") color = "far-shade";
      else if (above === "snow" || above === "snow-shade") color = "snow-shade";
      else if (above === "mid" || above === "mid-shade") color = "mid-shade";
      const half = 3 + depth * 1.2;
      const dx = Math.abs(x - SUN.x);
      if (depth % 2 === 0 && dx <= half && fbm(x / 3, 30 + y) > 0.45) color = dx < half * 0.4 ? "glow" : "sun";
      set(x, y, color);
    }
  }

  // A bright line where the lake meets the far bank, broken by noise and warmer near the sun.
  for (let x = 0; x < WIDTH; x++) {
    if (fbm(x / 4, 80) > 0.42) set(x, LAKE, Math.abs(x - SUN.x) < 60 ? "glow" : "cloud");
  }

  // Canoe and paddler in silhouette, a broken reflection under them and a wake behind.
  {
    const { x, y } = CANOE;
    for (let dx = -7; dx <= 7; dx++) set(x + dx, y, "tree");
    for (let dx = -5; dx <= 5; dx++) set(x + dx, y + 1, "tree");
    set(x - 8, y - 1, "tree");
    set(x + 8, y - 1, "tree");
    // Seated figure: head, shoulders, body.
    set(x - 1, y - 5, "tree");
    for (let dx = -2; dx <= 0; dx++) set(x + dx, y - 4, "tree");
    for (let dy = -3; dy <= -1; dy++) for (let dx = -2; dx <= 0; dx++) set(x + dx, y + dy, "tree");
    // Paddle across the body, its blade in the water.
    for (let i = 0; i < 8; i++) set(x - 3 + i, y - 6 + i, "tree");
    set(x + 5, y + 2, "tree");
    set(x + 6, y + 2, "tree");
    for (let dy = 2; dy <= 5; dy++) {
      for (let dx = -5 + dy; dx <= 5 - dy; dx++) if ((dx + dy) % 2 === 0) set(x + dx - 1, y + dy, "mid-shade");
    }
    for (let dx = 9; dx <= 22; dx++) {
      if (hash(dx, 90) > 0.4) set(x + dx, y + 1 + Math.floor(dx / 8), "cloud");
    }
  }

  // Shore with grass tufts and dark speckles, then pines on it: taller where the shore rises toward the viewer.
  for (let x = 0; x < WIDTH; x++) {
    const shore = shoreAt(x);
    // Ripples lap at the waterline wherever the shore runs into the lake.
    if (shore > LAKE + 1 && shore < HEIGHT && hash(x, 72) > 0.35) set(x + (x < SUN.x ? 1 : -1), shore - 1, "cloud");
    if (hash(x, 70) > 0.6) set(x, shore - 1, "near");
    for (let y = shore; y < HEIGHT; y++) set(x, y, hash(x * 977 + y, 71) > 0.9 ? "tree" : "near");
  }
  for (let cx = -4; cx < WIDTH + 4; cx += 2 + Math.floor(hash(cx, 50) * 4)) {
    const ground = shoreAt(Math.min(Math.max(cx, 0), WIDTH - 1));
    // A clearing around the cabin.
    if (ground > 93 || (cx > CABIN.x - 3 && cx < CABIN.x + CABIN.w + 2)) continue;
    const h = Math.round(8 + (94 - ground) * 0.55 + hash(cx, 51) * 7);
    const base = ground + 2;
    const lit = cx < SUN.x ? 1 : -1;
    for (let r = 0; r < h - 1; r++) {
      // Each tier of branches flares out, then the next starts narrower; jitter frays the edges.
      const half = Math.floor(r * 0.2 + (r % 4) * 0.35);
      const left = half + (hash(r, cx * 7) > 0.75 ? 1 : 0);
      const right = half + (hash(r, cx * 7 + 1) > 0.75 ? 1 : 0);
      for (let dx = -left; dx <= right; dx++) {
        const edge = dx === (lit > 0 ? right : -left);
        set(cx + dx, base - h + r, edge && half > 0 && r % 2 === 1 ? "near" : "tree");
      }
    }
    set(cx, base - 1, "tree");
  }

  // Cabin in a clearing: sunlit log walls, a lit window, a door, a roof and chimney smoke.
  {
    const { x, w } = CABIN;
    let base = 0;
    for (let dx = 0; dx < w; dx++) base = Math.max(base, shoreAt(x + dx));
    for (let dy = 1; dy <= 7; dy++) {
      for (let dx = 0; dx < w; dx++) set(x + dx, base - dy, dy % 2 === 0 ? "near" : "far-shade");
    }
    for (let dy = 3; dy <= 5; dy++) for (let dx = 3; dx <= 6; dx++) set(x + dx, base - dy, dy === 4 && dx === 4 ? "glow" : "sun");
    for (let dy = 1; dy <= 5; dy++) for (let dx = 10; dx <= 12; dx++) set(x + dx, base - dy, "tree");
    // Shingled roof, its ridge catching the sunset: overhangs the walls, narrows to the top.
    for (let r = 0; r <= 5; r++) {
      for (let dx = -2 + r; dx <= w + 1 - r; dx++) set(x + dx, base - 8 - r, r === 5 ? "far" : r % 2 === 0 ? "tree" : "near");
    }
    const chimney = x + w - 5;
    for (let dy = 11; dy <= 16; dy++) for (let dx = 0; dx <= 1; dx++) set(chimney + dx, base - dy, "tree");
    // Smoke: puffs that grow, thin out and drift away from the sun as they rise.
    for (let i = 0; i < 7; i++) {
      const px = chimney - i * 2 - Math.round(Math.sin(i) * 1.5);
      const py = base - 19 - i * 3;
      const r = 1 + i * 0.45;
      for (let y = Math.floor(py - r); y <= py + r; y++) {
        for (let x = Math.floor(px - r); x <= px + r; x++) {
          if ((x - px) ** 2 + (y - py) ** 2 <= r * r && dither(x, y, 0.95 - i * 0.12)) set(x, y, "cloud");
        }
      }
    }
  }

  // Jetty: sunlit planks on posts, the posts mirrored in the water below.
  {
    const { x, w, y } = JETTY;
    for (let dx = 0; dx <= w; dx++) {
      set(x + dx, y, "far");
      set(x + dx, y + 1, "tree");
    }
    for (let dx = 2; dx <= w; dx += 6) {
      for (let dy = 2; dy <= 3; dy++) set(x + dx, y + dy, "tree");
      if (shoreAt(x + dx) > y + 3) for (let dy = 4; dy <= 6; dy += 2) set(x + dx, y + dy, "mid-shade");
    }
  }

  // Rocks: rounded, lit on top, dark below.
  for (const [rx, w, h] of ROCKS) {
    for (let r = 0; r < h; r++) {
      const inset = r === 0 ? 1 : 0;
      for (let dx = inset; dx < w - inset; dx++) set(rx + dx, HEIGHT - h + r, r === 0 ? "far-shade" : "near");
    }
  }

  // Reeds in the shallows off the right shore, some leaning, with seed heads.
  for (let x = 366; x < 400; x += 1 + Math.floor(hash(x, 95) * 3)) {
    if (shoreAt(x) < HEIGHT - 2) continue;
    const h = 3 + Math.floor(hash(x, 96) * 5);
    const lean = hash(x, 97) > 0.6 ? 1 : 0;
    for (let r = 0; r < h; r++) set(x + (r > h / 2 ? lean : 0), HEIGHT - 1 - r, r === h - 1 ? "near" : "tree");
  }

  // Birds: a flock caught mid-flap, and a far one as single "v"s.
  BIRDS.forEach(([bx, by], i) => {
    for (const [dx, dy] of WINGS[i % WINGS.length]!) set(bx + dx, by + dy, "bird");
  });
  for (const [bx, by] of FAR_BIRDS) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1]] as const) set(bx + dx, by + dy, "bird");
  }

  const runs: PixelArt["runs"] = [];
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
  return { width: WIDTH, height: HEIGHT, runs };
}
