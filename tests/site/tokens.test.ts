import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../site/src/styles/tokens.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");

function themeBlocks(source: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  for (const [, id, body] of source.matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)) {
    const tokens = new Map<string, string>();
    for (const [, name, value] of body!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens.set(name!, value!.trim());
    blocks.set(id!, tokens);
  }
  return blocks;
}

const blocks = themeBlocks(css);
const app = themeBlocks(appCss);

type Rgb = [number, number, number];

function hslToRgb(triplet: string): Rgb {
  const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(triplet);
  if (!match) throw new Error(`not an HSL triplet: ${triplet}`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

const luminance = ([r, g, b]: Rgb): number => {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `top` at `alpha` over `bottom`, as hsl(var(--x) / alpha) renders it. */
const blend = (top: Rgb, bottom: Rgb, alpha: number): Rgb => top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as Rgb;

/** A surface: a token, or a token at some opacity over another surface. */
type Surface = string | [string, number, Surface];

/**
 * Every text color the site sets, on every surface it sets it on (src/styles/main.css). Kept by
 * hand next to the stylesheet: a new text pair belongs here.
 */
const TEXT_PAIRS: Array<[text: string, surfaces: Surface[], textAlpha?: number]> = [
  ["foreground", ["background", "background-deep", "card", "muted", "art-sky", "art-horizon", ["card", 0.7, "art-sky"], ["primary", 0.07, "background"]]],
  ["foreground", ["art-sky", "art-horizon"], 0.82],
  ["muted-foreground", ["background", "background-deep", "card", "art-sky", "art-horizon", ["muted", 0.6, "card"]]],
  ["primary", ["background", "background-deep", "card"]],
  ["primary-foreground", ["primary", "primary-hover"]],
  ["destructive", ["card", "background", ["destructive", 0.1, "card"], ["destructive", 0.08, "card"]]],
  ["warning", ["card", ["warning", 0.1, "card"], ["warning", 0.1, "background"]]],
  ["success", ["card", "background"]],
  ["info", ["card", ["info", 0.1, "card"]]],
  ["muted-foreground", [["muted-foreground", 0.1, "card"]]],
  ["foreground", [["destructive", 0.1, "background"], ["destructive", 0.08, "card"]]],
  ["term-foreground", ["term", "term-bar"]],
  ["term-muted", ["term", "term-bar"]],
  ["term-accent", ["term", "term-bar"]],
  ["term-ok", ["term", "term-bar"]],
  ["term-err", ["term"]],
  ["term-warn", ["term"]],
  ["art-msg", ["art-near", ["art-tree", 0.72, "art-near"]]],
];

function resolve(theme: Map<string, string>, surface: Surface): Rgb {
  if (typeof surface === "string") return hslToRgb(theme.get(surface)!);
  const [token, alpha, below] = surface;
  return blend(hslToRgb(theme.get(token)!), resolve(theme, below), alpha);
}

describe("site theme tokens", () => {
  it("has exactly a light and a dark theme, defining the same tokens", () => {
    expect([...blocks.keys()].sort()).toEqual(["dark", "light"]);
    expect([...blocks.get("dark")!.keys()].sort()).toEqual([...blocks.get("light")!.keys()].sort());
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  });

  it("matches the review app: light is Default Light, dark is Terminal Dark", () => {
    const shared = ["background", "foreground", "card", "muted", "muted-foreground", "border", "primary", "primary-foreground", "accent", "destructive", "warning", "success", "info"];
    for (const [site, appTheme] of [["light", "light"], ["dark", "terminal"]] as const) {
      for (const token of shared) expect(blocks.get(site)!.get(token), `${site} ${token}`).toBe(app.get(appTheme)!.get(token));
      for (const [token, value] of app.get(appTheme)!) if (token.startsWith("art-") && token !== "art-water") expect(blocks.get(site)!.get(token), `${site} ${token}`).toBe(value);
    }
  });

  it("keeps every text pair at WCAG AA (4.5:1) in both themes", () => {
    for (const [id, theme] of blocks) {
      for (const [text, surfaces, textAlpha = 1] of TEXT_PAIRS) {
        for (const surface of surfaces) {
          const below = resolve(theme, surface);
          const ratio = contrast(blend(hslToRgb(theme.get(text)!), below, textAlpha), below);
          expect(ratio, `${id}: ${text} on ${JSON.stringify(surface)} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
