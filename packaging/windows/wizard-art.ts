/**
 * The Windows installer's artwork, drawn from the app's own pixel-art landscape
 * (web/src/art/landscape.ts) in two themes: Default Light (the sunset with its balloon) when
 * Windows is in light mode, Terminal Dark (the night with its fireflies) in dark mode. Colors come
 * from each theme's --art-* tokens in web/src/index.css, so the installer matches the app.
 *
 * Usage: tsx packaging/windows/wizard-art.ts <out-dir>
 *
 * Writes, for Inno Setup 6.6 and newer:
 * - the landscape as the background of the whole wizard (WizardBackImageFile) at every DPI step,
 * - the padlock tile (WizardSmallImageFile) at every DPI step,
 * - the app's buttons (web/src/components/ui.tsx buttonClass): primary and secondary, each normal,
 *   hover and disabled, which latchverify.iss draws over the wizard's own buttons,
 * - include files for latchverify.iss: wizard-art.iss (light [Setup] directives, and #defines the
 *   [Code] reads), wizard-art-dark.iss (the DynamicDark directives) and wizard-files.iss ([Files]).
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

/** Inno Setup 6.6's background image area (the whole wizard, 497:360) at 100% to 250% DPI. */
export const BACK_SIZES: ReadonlyArray<[number, number]> = [
  [596, 432], [796, 576], [994, 720], [1193, 864], [1272, 922], [1471, 1066], [1630, 1148],
];
/** Inno Setup 6.6's left-hand image area of the Welcome and Finished pages at 100% to 250% DPI. */
export const WELCOME_SIZES: ReadonlyArray<[number, number]> = [
  [202, 386], [269, 515], [336, 643], [403, 772], [430, 824], [498, 953], [534, 1022],
];
/** Inno Setup 6.6's small image (top right of the inner pages) at 100% to 250% DPI. */
export const SMALL_SIZES: readonly number[] = [58, 77, 97, 116, 124, 143, 159];
/** One size for every button image: 3x a button at 100% DPI; the installer stretches it to the real button. */
export const BUTTON_SIZE: Readonly<[number, number]> = [270, 78];
export const BUTTON_KINDS = ["primary", "secondary"] as const;
export const BUTTON_STATES = ["normal", "hover", "disabled"] as const;

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
  /** Paints `art` at `scale` with its pixel (ax, ay) at canvas (x0, y0), hidden layers left out; `keep` can skip runs by canvas row. */
  draw(art: PixelArt, colors: Map<string, Rgb>, scale: number, x0: number, y0: number, keep: (y: number, x: number) => boolean = () => true): void {
    for (const layer of art.layers) {
      if (HIDDEN.has(layer.name)) continue;
      for (const run of layer.runs) {
        if (!keep(y0 + run.y * scale, x0 + run.x * scale)) continue;
        const color = colors.get(`art-${run.color satisfies ArtColor}`);
        if (color === undefined) throw new Error(`the theme has no --art-${run.color}`);
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < run.w * scale; dx++) this.set(x0 + run.x * scale + dx, y0 + run.y * scale + dy, color);
      }
    }
  }
}

/**
 * The background of the whole wizard: the scene along the bottom at a whole-number scale wide
 * enough to fill it, cropped around the sun, its sky stretched to the top, where the text is.
 */
export function backImage(colors: Map<string, Rgb>, time: ArtTime, extra: ArtExtra, width: number, height: number): Canvas {
  const art = landscape(time, extra);
  const scale = Math.ceil(width / art.width);
  const top = height - art.height * scale;
  const sky = colors.get("art-sky")!;
  const horizon = colors.get("art-horizon")!;
  const horizonY = top + HORIZON_ROW * scale;
  const canvas = new Canvas(width, height);
  for (let y = 0; y < height; y++) {
    const color = mix(sky, horizon, Math.min(1, Math.max(0, y / horizonY) ** 1.6));
    for (let x = 0; x < width; x++) canvas.set(x, y, color);
  }
  const x0 = Math.min(0, Math.max(width - art.width * scale, Math.round(width / 2 - SUN_X * scale)));
  if (time === "night") {
    const stars = starrySky();
    // The top of the wizard holds its text: no stars there, and fewer just below.
    const clear = height * 0.3;
    const thin = height * 0.5;
    canvas.draw(stars, colors, scale, x0, top - stars.height * scale, (y, x) => y >= thin || (y >= clear && (x * 7 + y * 13) % 3 === 0));
  }
  canvas.draw(art, colors, scale, x0, top);
  return canvas;
}

/** The colors of one button image, from the theme: buttonClass in web/src/components/ui.tsx. */
export function buttonColors(colors: Map<string, Rgb>, kind: (typeof BUTTON_KINDS)[number], state: (typeof BUTTON_STATES)[number]): { fill: Rgb; border: Rgb; text: Rgb; alpha: number } {
  const get = (name: string) => {
    const color = colors.get(name);
    if (color === undefined) throw new Error(`the theme has no --${name}`);
    return color;
  };
  const primary = kind === "primary";
  const base = primary ? get("primary") : get("card");
  // hover:bg-primary/90 over the background, and hover:bg-muted.
  const fill = state === "hover" ? (primary ? mix(base, get("background"), 0.1) : get("muted")) : base;
  return { fill, border: primary ? get("primary") : get("input"), text: primary ? get("primary-foreground") : get("foreground"), alpha: state === "disabled" ? 0.5 : 1 };
}

/** A rounded button face (rounded-md, a 1px border at 100% DPI), antialiased, transparent outside. */
export function buttonImage(colors: { fill: Rgb; border: Rgb; alpha: number }, [width, height]: Readonly<[number, number]> = BUTTON_SIZE): Canvas {
  const canvas = new Canvas(width, height);
  const radius = height * 0.2;
  const borderWidth = height / 26;
  const SAMPLES = 4;
  /** Distance inside the rounded rectangle (negative outside). */
  const inside = (px: number, py: number) => {
    const cx = Math.min(Math.max(px, radius), width - radius);
    const cy = Math.min(Math.max(py, radius), height - radius);
    return radius - Math.hypot(px - cx, py - cy);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cover = 0;
      let border = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const d = inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          if (d <= 0) continue;
          cover++;
          if (d <= borderWidth) border++;
        }
      }
      if (cover === 0) continue;
      const color = mix(colors.fill, colors.border, border / cover);
      canvas.set(x, y, [...color, Math.round(255 * colors.alpha * (cover / SAMPLES ** 2))] as Rgba);
    }
  }
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

/** Paints the padlock on a rounded tile of the theme's sky, `size` square, its corner at (left, top). */
function drawTile(canvas: Canvas, colors: Map<string, Rgb>, size: number, left: number, top: number, dark: boolean): void {
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
      canvas.set(left + x, top + y, mix(sky, horizon, (y - inset) / (size - 2 * inset)));
    }
  }
  const offset = Math.floor((size - 16 * scale) / 2);
  const outline = [0, 2, 4].map((i) => parseInt(OUTLINE.slice(i, i + 2), 16)).join();
  for (const run of padlock()) {
    const color = dark && run.color.join() === outline ? colors.get("foreground")! : run.color;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < run.w * scale; dx++) canvas.set(left + offset + run.x * scale + dx, top + offset + run.y * scale + dy, color);
  }
}

/** The small image: the padlock tile, the rest transparent. */
export function smallImage(colors: Map<string, Rgb>, size: number, dark = false): Canvas {
  const canvas = new Canvas(size, size);
  drawTile(canvas, colors, size, 0, 0, dark);
  return canvas;
}

/** The Welcome and Finished pages' image: the padlock tile near the top, beside the heading; transparent elsewhere, so the landscape shows. */
export function welcomeImage(colors: Map<string, Rgb>, width: number, height: number, dark = false): Canvas {
  const canvas = new Canvas(width, height);
  const size = Math.round(width * 0.62);
  drawTile(canvas, colors, size, Math.round((width - size) / 2), Math.round(height * 0.08), dark);
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

/** "#rrggbb", as Inno Setup's WizardBackColor takes it. */
const hex = (color: Rgb) => `#${color.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
/** A Pascal TColor literal, $00bbggrr: needs no StrToColor, which older Inno Setup 6 releases lack. */
const tColor = ([r, g, b]: Rgb) => `$00${[b, g, r].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Writes every image and the three include files into `out`. Returns the files written. */
export function writeWizardArt(out: string): string[] {
  mkdirSync(out, { recursive: true });
  const css = readFileSync(join(root, "web/src/index.css"), "utf8");
  const written: string[] = [];
  const setup: Record<string, string[]> = { light: [], dark: [] };
  const files: string[] = [];
  const write = (name: string, canvas: Canvas) => {
    writeFileSync(join(out, name), png(canvas));
    written.push(name);
    return name;
  };
  const list = (names: string[]) => names.map((name) => join(resolve(out), name)).join(",");
  for (const { mode, theme, time, extra } of WIZARD_THEMES) {
    const colors = themeColors(css, theme);
    const back = BACK_SIZES.map(([w, h]) => write(`wizard-back-${mode}-${w}x${h}.png`, backImage(colors, time, extra, w, h)));
    const small = SMALL_SIZES.map((size) => write(`wizard-small-${mode}-${size}.png`, smallImage(colors, size, mode === "dark")));
    const welcome = WELCOME_SIZES.map(([w, h]) => write(`wizard-welcome-${mode}-${w}x${h}.png`, welcomeImage(colors, w, h, mode === "dark")));
    const suffix = mode === "dark" ? "DynamicDark" : "";
    setup[mode]!.push(
      `WizardBackColor${suffix}=${hex(colors.get("background")!)}`,
      `WizardBackImageFile${suffix}=${list(back)}`,
      `WizardImageFile${suffix}=${list(welcome)}`,
      `WizardSmallImageFile${suffix}=${list(small)}`,
    );
    for (const kind of BUTTON_KINDS) {
      for (const state of BUTTON_STATES) {
        const button = buttonColors(colors, kind, state);
        const name = write(`button-${kind}-${state}-${mode}.png`, buttonImage(button));
        files.push(`Source: "${join(resolve(out), name)}"; Flags: dontcopy noencryption`);
        // The label the installer draws over the image (#define for its [Code]).
        if (state !== "hover") setup[mode]!.push(`#define ButtonText_${kind}_${state}_${mode} "${tColor(state === "disabled" ? mix(button.text, button.fill, 0.5) : button.text)}"`);
      }
    }
  }
  for (const [file, lines] of [["wizard-art.iss", setup.light!], ["wizard-art-dark.iss", setup.dark!], ["wizard-files.iss", files]] as const) {
    writeFileSync(join(out, file), `; Written by packaging/windows/wizard-art.ts.\n${lines.join("\n")}\n`);
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
