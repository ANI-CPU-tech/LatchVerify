/**
 * Original pixel-art landscape (sun, mountains, pines, birds), generated from a few shapes so
 * it stays crisp at any size. Pure data: the React component (PixelLandscape.tsx) paints each
 * color with a theme token (--art-*), so every theme recolors it without new assets.
 */

export const ART_COLORS = ["glow", "sun", "far", "snow", "near", "tree", "bird"] as const;
export type ArtColor = (typeof ART_COLORS)[number];

export interface PixelArt {
  width: number;
  height: number;
  /** Horizontal runs of one color, painted in ART_COLORS order. */
  runs: Array<{ x: number; y: number; w: number; color: ArtColor }>;
}

interface Scene {
  width: number;
  height: number;
  sun: { x: number; y: number; r: number };
  /** Ridge lines as [x, y] points, left to right, spanning the full width. */
  far: Array<[number, number]>;
  near: Array<[number, number]>;
  /** Pines as [x, height]; each stands on the near ridge. */
  pines: Array<[number, number]>;
  birds: Array<[number, number]>;
}

const SCENES = {
  /** Dashboard header: wide, sun to the right. */
  wide: {
    width: 160,
    height: 56,
    sun: { x: 112, y: 30, r: 14 },
    far: [[0, 42], [20, 31], [36, 37], [60, 20], [82, 34], [98, 27], [118, 39], [140, 23], [160, 33]],
    near: [[0, 49], [28, 43], [50, 51], [76, 42], [104, 51], [130, 45], [160, 52]],
    pines: [[6, 12], [12, 16], [18, 11], [122, 13], [129, 17], [136, 12], [148, 15], [154, 10]],
    birds: [[38, 10], [46, 6], [53, 12]],
  },
  /** Sidebar footer: narrow and tall, pines in front. */
  tall: {
    width: 64,
    height: 72,
    sun: { x: 38, y: 34, r: 12 },
    far: [[0, 46], [14, 32], [26, 40], [40, 26], [52, 38], [64, 30]],
    near: [[0, 58], [18, 52], [34, 60], [50, 54], [64, 60]],
    pines: [[5, 18], [12, 24], [20, 15], [48, 16], [56, 22], [62, 14]],
    birds: [[10, 12], [18, 8], [24, 14]],
  },
} satisfies Record<string, Scene>;

export type ArtVariant = keyof typeof SCENES;

/** y of a ridge at column x (linear between points, rounded to whole pixels). */
function ridgeAt(points: Array<[number, number]>, x: number): number {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (x <= x1) return Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return points[points.length - 1]![1];
}

export function landscape(variant: ArtVariant): PixelArt {
  const scene: Scene = SCENES[variant];
  const { width, height } = scene;
  const grid: Array<ArtColor | null> = new Array(width * height).fill(null);
  const set = (x: number, y: number, color: ArtColor) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grid[y * width + x] = color;
  };

  // Sun with a one-pixel dithered halo. Distances are squared to stay in integers.
  const { sun } = scene;
  for (let y = sun.y - sun.r - 3; y <= sun.y + sun.r + 3; y++) {
    for (let x = sun.x - sun.r - 3; x <= sun.x + sun.r + 3; x++) {
      const d = (x - sun.x) ** 2 + (y - sun.y) ** 2;
      if (d <= sun.r ** 2) set(x, y, "sun");
      else if (d <= (sun.r + 2) ** 2 && (x + y) % 2 === 0) set(x, y, "glow");
    }
  }

  // Far range, with snow on the top rows of the high peaks.
  const peak = Math.min(...scene.far.map(([, y]) => y));
  for (let x = 0; x < width; x++) {
    const top = ridgeAt(scene.far, x);
    for (let y = top; y < height; y++) set(x, y, y - top < 3 && top <= peak + 6 ? "snow" : "far");
  }

  for (let x = 0; x < width; x++) {
    for (let y = ridgeAt(scene.near, x); y < height; y++) set(x, y, "near");
  }

  // Pines: stepped tiers, two-pixel trunk, standing a little into the near ridge.
  for (const [cx, h] of scene.pines) {
    const base = ridgeAt(scene.near, cx) + 2;
    const top = base - h;
    for (let r = 0; r < h - 2; r++) {
      // Widens every other row; every fourth row steps back in, which reads as tiers.
      const half = Math.floor(r / 2) - (r > 0 && r % 4 === 0 ? 1 : 0);
      for (let dx = -half; dx <= half; dx++) set(cx + dx, top + r, "tree");
    }
    set(cx, base - 2, "tree");
    set(cx, base - 1, "tree");
  }

  // Birds: a distant gull, two raised wings ("^^").
  for (const [bx, by] of scene.birds) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [-2, 1], [0, 1], [2, 1]] as const) set(bx + dx, by + dy, "bird");
  }

  const runs: PixelArt["runs"] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const color = grid[y * width + x];
      let end = x + 1;
      while (end < width && grid[y * width + end] === color) end++;
      if (color) runs.push({ x, y, w: end - x, color });
      x = end;
    }
  }
  return { width, height, runs };
}
