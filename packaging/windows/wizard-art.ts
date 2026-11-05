/**
 * The Windows installer's artwork, drawn from the app's own pixel-art landscape
 * (web/src/art/landscape.ts) in two themes: Default Light (the sunset with its balloon) when
 * Windows is in light mode, Terminal Dark (the night with its fireflies) in dark mode. Colors come
 * from each theme's --art-* tokens in web/src/index.css, so the installer matches the app.
 *
 * Usage: tsx packaging/windows/wizard-art.ts <out-dir>
 *
 * Writes PNGs at every DPI step Inno Setup picks from, plus two include files for latchverify.iss:
 * wizard-art.iss (light, WizardImageFile and WizardSmallImageFile) and wizard-art-dark.iss (the
 * DynamicDark directives, Inno Setup 6.6 and newer).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { landscape, starrySky, type ArtColor, type ArtExtra, type ArtTime, type PixelArt } from "../../web/src/art/landscape.js";

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** The two themes the installer follows: the system's light and dark defaults (web/src/lib/themes.ts SYSTEM_THEMES). */
export const WIZARD_THEMES = [
  { mode: "light", theme: "light", time: "day", extra: "balloon" },
  { mode: "dark", theme: "terminal", time: "night", extra: "fireflies" },
] as const satisfies ReadonlyArray<{ mode: string; theme: string; time: ArtTime; extra: ArtExtra }>;

/** Inno Setup's large image (Welcome and Finished pages) at 100% to 250% DPI. */
export const LARGE_SIZES: ReadonlyArray<[number, number]> = [
  [164, 314], [192, 386], [246, 459], [273, 556], [328, 604], [355, 700], [410, 797],
];
/** Inno Setup's small image (top right of the other pages) at 100% to 250% DPI. */
export const SMALL_SIZES: readonly number[] = [58, 73, 87, 102, 116, 145];

/** Layers index.css hides in the still scene (second poses and copies). */
const HIDDEN = new Set(["glint-b", "smoke-b", "birds-b", "geese-b", "fireflies-b", "shooting-star", "deer-b"]);
/** Where the art's sun (and moon) is; the portrait crop centers on it. */
const SUN_X = 300;
/** The lake's water line in art rows: the sky gradient reaches the horizon color there. */
const HORIZON_ROW = 74;

const root = resolve(import.meta.dirname, "../..");

/** A theme's CSS variables from web/src/index.css, as RGB. */
export function themeColors(css: string, theme: string): Map<string, Rgb> {
  const start = css.indexOf(`[data-theme="${theme}"] {`);
  if (start === -1) throw new Error(`index.css has no ${theme} theme`);
  const block = css.slice(start, css.indexOf("}", start));
  const colors = new Map<string, Rgb>();
  for (const [, name, h, s, l] of block.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g)) colors.set(name!, hsl(Number(h), Number(s) / 100, Number(l) / 100));
  return colors;
}

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as Rgb;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as Rgb;

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }
  set(x: number, y: number, [r, g, b, a = 255]: Rgb | Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data.set([r, g, b, a], (y * this.width + x) * 4);
  }
  /** Paints `art` at `scale` with its pixel (ax, ay) at canvas (x0, y0), hidden layers left out. */
  draw(art: PixelArt, colors: Map<string, Rgb>, scale: number, x0: number, y0: number): void {
    for (const layer of art.layers) {
      if (HIDDEN.has(layer.name)) continue;
      for (const run of layer.runs) {
        const color = colors.get(`art-${run.color satisfies ArtColor}`);
        if (color === undefined) throw new Error(`the theme has no --art-${run.color}`);
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < run.w * scale; dx++) this.set(x0 + run.x * scale + dx, y0 + run.y * scale + dy, color);
      }
    }
  }
}

/** The large image: the scene at the bottom, cropped around the sun, its sky stretched to the top. */
export function largeImage(colors: Map<string, Rgb>, time: ArtTime, extra: ArtExtra, width: number, height: number): Canvas {
  const art = landscape(time, extra);
  const scale = Math.max(1, Math.floor((height * 0.62) / art.height));
  const top = height - art.height * scale;
  const sky = colors.get("art-sky")!;
  const horizon = colors.get("art-horizon")!;
  const horizonY = top + HORIZON_ROW * scale;
  const canvas = new Canvas(width, height);
  for (let y = 0; y < height; y++) {
    const color = mix(sky, horizon, Math.min(1, y / horizonY));
    for (let x = 0; x < width; x++) canvas.set(x, y, color);
  }
  const x0 = Math.round(width / 2 - SUN_X * scale);
  if (time === "night") {
    const stars = starrySky();
    canvas.draw(stars, colors, scale, x0, top - stars.height * scale);
  }
  canvas.draw(art, colors, scale, x0, top);
  return canvas;
}

/** The padlock of web/public/favicon.svg as 16x16 pixels. */
export function padlock(): Array<{ x: number; y: number; w: number; color: Rgb }> {
  const svg = readFileSync(join(root, "web/public/favicon.svg"), "utf8");
  const runs: Array<{ x: number; y: number; w: number; color: Rgb }> = [];
  for (const [, hex, d] of svg.matchAll(/<path fill="#([0-9a-f]{6})" d="([^"]+)"/g)) {
    const color = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16)) as Rgb;
    for (const [, x, y, w] of d!.matchAll(/M(\d+) (\d+)h(\d+)/g)) runs.push({ x: Number(x), y: Number(y), w: Number(w), color });
  }
  if (runs.length === 0) throw new Error("web/public/favicon.svg has no pixel paths");
  return runs;
}

/** The favicon's outline color: on a dark tile it takes the theme's text color, as the app's header glow does. */
const OUTLINE = "241d17";

/** The small image: the padlock on a rounded tile of the theme's sky, the rest transparent. */
export function smallImage(colors: Map<string, Rgb>, size: number, dark = false): Canvas {
  const canvas = new Canvas(size, size);
  const scale = Math.max(1, Math.floor((size * 0.7) / 16));
  const inset = Math.round(size * 0.04);
  const radius = Math.round(size * 0.18);
  const sky = colors.get("art-sky")!;
  const horizon = colors.get("art-horizon")!;
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) {
      const cx = Math.min(Math.max(x, inset + radius), size - inset - radius - 1);
      const cy = Math.min(Math.max(y, inset + radius), size - inset - radius - 1);
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      canvas.set(x, y, mix(sky, horizon, (y - inset) / (size - 2 * inset)));
    }
  }
  const offset = Math.floor((size - 16 * scale) / 2);
  const outline = [0, 2, 4].map((i) => parseInt(OUTLINE.slice(i, i + 2), 16)).join();
  for (const run of padlock()) {
    const color = dark && run.color.join() === outline ? colors.get("foreground")! : run.color;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < run.w * scale; dx++) canvas.set(offset + run.x * scale + dx, offset + run.y * scale + dy, color);
  }
  return canvas;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** An RGBA PNG of `canvas`. */
export function png(canvas: Canvas): Buffer {
  const chunk = (type: string, body: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = canvas.width * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) raw.set(canvas.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

/** Writes every image and the two include files into `out`. Returns the files written. */
export function writeWizardArt(out: string): string[] {
  mkdirSync(out, { recursive: true });
  const css = readFileSync(join(root, "web/src/index.css"), "utf8");
  const written: string[] = [];
  const directives: Record<string, string[]> = { light: [], dark: [] };
  for (const { mode, theme, time, extra } of WIZARD_THEMES) {
    const colors = themeColors(css, theme);
    const large = LARGE_SIZES.map(([w, h]) => {
      const name = `wizard-${mode}-${w}x${h}.png`;
      writeFileSync(join(out, name), png(largeImage(colors, time, extra, w, h)));
      return name;
    });
    const small = SMALL_SIZES.map((size) => {
      const name = `wizard-small-${mode}-${size}.png`;
      writeFileSync(join(out, name), png(smallImage(colors, size, mode === "dark")));
      return name;
    });
    written.push(...large, ...small);
    const list = (names: string[]) => names.map((name) => join(resolve(out), name)).join(",");
    const suffix = mode === "dark" ? "DynamicDark" : "";
    directives[mode]!.push(`WizardImageFile${suffix}=${list(large)}`, `WizardSmallImageFile${suffix}=${list(small)}`);
  }
  for (const [mode, file] of [["light", "wizard-art.iss"], ["dark", "wizard-art-dark.iss"]] as const) {
    writeFileSync(join(out, file), `; Written by packaging/windows/wizard-art.ts.\n${directives[mode]!.join("\n")}\n`);
    written.push(file);
  }
  return written;
}

if (process.argv[1]?.endsWith("wizard-art.ts")) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error("usage: wizard-art.ts <out-dir>");
    process.exit(2);
  }
  const files = writeWizardArt(out);
  console.log(`wrote ${files.length} files to ${resolve(out)}`);
}
