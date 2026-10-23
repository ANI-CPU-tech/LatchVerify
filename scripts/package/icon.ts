import { encodeIco, encodePng } from "./png.js";

/**
 * The LatchVerify app icon: a 16x16 pixel-art padlock with a sunset over mountains in its body.
 * One grid is the source for every size and format (PNG, ICO, SVG), scaled by whole pixels so
 * the edges stay crisp.
 */
export const ICON_GRID = [
  "................",
  ".....kkkkkk.....",
  "....kk....kk....",
  "....k......k....",
  "....k......k....",
  "....k......k....",
  "..kkkkkkkkkkkk..",
  "..kggggggggggk..",
  "..kgggggoogggk..",
  "..kggggooooggk..",
  "..kgfggoooofgk..",
  "..kfffgooofffk..",
  "..kffffffffnfk..",
  "..knnffffnnnnk..",
  "..kkkkkkkkkkkk..",
  "................",
] as const;

/** Default Light colors (web/src/index.css), as RGB. "." is transparent. */
export const ICON_PALETTE: Record<string, readonly [number, number, number]> = {
  k: [0x24, 0x1d, 0x17], // outline: foreground
  g: [0xf8, 0xaa, 0x6e], // sky glow
  o: [0xf0, 0x64, 0x23], // sun: accent
  f: [0xc8, 0x6e, 0x4b], // far mountains
  n: [0x5d, 0x3e, 0x2c], // near ridge
};

export const ICON_PNG_SIZES = [16, 32, 48, 64, 128, 256, 512] as const;
export const ICON_ICO_SIZES = [16, 32, 48, 256] as const;

/** RGBA pixels of the icon at `size` (a multiple of 16). */
export function iconPixels(size: number): Uint8Array {
  const n = ICON_GRID.length;
  if (size % n !== 0) throw new RangeError(`icon size must be a multiple of ${n}, got ${size}`);
  const scale = size / n;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = ICON_PALETTE[ICON_GRID[Math.floor(y / scale)]![Math.floor(x / scale)]!];
      if (color) pixels.set([...color, 255], (y * size + x) * 4);
    }
  }
  return pixels;
}

export const iconPng = (size: number): Buffer => encodePng(size, size, iconPixels(size));

export const iconIco = (): Buffer => encodeIco(ICON_ICO_SIZES.map((size) => ({ size, png: iconPng(size) })));

const hex = ([r, g, b]: readonly [number, number, number]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** The icon as SVG: one path per color, crisp edges. Also web/public/favicon.svg. */
export function iconSvg(): string {
  const paths = Object.entries(ICON_PALETTE).map(([key, rgb]) => {
    let d = "";
    ICON_GRID.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {
        if (row[x] !== key) {
          x++;
          continue;
        }
        let end = x + 1;
        while (row[end] === key) end++;
        d += `M${x} ${y}h${end - x}v1h${x - end}z`;
        x = end;
      }
    });
    return `<path fill="${hex(rgb)}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${paths.join("")}</svg>\n`;
}
