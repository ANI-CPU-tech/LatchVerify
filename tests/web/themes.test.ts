import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCE,
  THEMES,
  THEME_STORAGE_KEY,
  isDarkTheme,
  parsePreference,
  readPreference,
  resolveTheme,
  writePreference,
} from "../../web/src/lib/themes.js";
import { surfaceAlpha } from "../../web/src/lib/surface.js";

const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

/** Token name to value, for every [data-theme="id"] block in index.css. */
const blocks = new Map<string, Map<string, string>>();
for (const [, id, body] of css.matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)) {
  const tokens = new Map<string, string>();
  for (const [, name, value] of body!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens.set(name!, value!.trim());
  blocks.set(id!, tokens);
}

type Rgb = [number, number, number];

/** "h s% l%" to sRGB in 0..1. */
function hslToRgb(triplet: string): Rgb {
  const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(triplet);
  if (!match) throw new Error(`not an HSL triplet: ${triplet}`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** `top` at `alpha` over `bottom`, as Tailwind's bg-x/15 renders it. */
const blend = (top: Rgb, bottom: Rgb, alpha: number): Rgb => top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as Rgb;

describe("theme tokens in index.css", () => {
  it("has a block for every registered theme, and no unregistered ones", () => {
    expect([...blocks.keys()].sort()).toEqual(THEMES.map((theme) => theme.id).sort());
  });

  it("marks a theme dark exactly when its block sets color-scheme: dark", () => {
    for (const { id } of THEMES) {
      const body = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)![1]!;
      expect(isDarkTheme(id), id).toBe(/color-scheme:\s*dark/.test(body));
    }
    expect(isDarkTheme("terminal")).toBe(true);
  });

  it("defines the same tokens in every theme", () => {
    const reference = [...blocks.get("light")!.keys()].sort();
    expect(reference.length).toBeGreaterThan(25);
    for (const [id, tokens] of blocks) expect([...tokens.keys()].sort(), id).toEqual(reference);
  });

  it("keeps Default Light on :root, so the page is themed before any script runs", () => {
    expect(css).toMatch(/:root,\s*\[data-theme="light"\]\s*\{/);
  });

  // WCAG 2.1 AA: 4.5:1 for text, 3:1 for focus rings and other UI components.
  const TEXT_PAIRS: Array<[string, string]> = [
    ["foreground", "background"],
    ["foreground", "card"],
    ["card-foreground", "card"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
    ["muted-foreground", "muted"],
    ["primary", "background"],
    ["primary", "card"],
    ["primary-foreground", "primary"],
    ["accent-foreground", "accent"],
    ["sidebar-foreground", "sidebar"],
    ["terminal-foreground", "terminal"],
    ["terminal-muted", "terminal"],
    ["terminal-accent", "terminal"],
    ...(["destructive", "warning", "success", "info"] as const).flatMap((status): Array<[string, string]> => [
      [status, "card"],
      [status, "background"],
      [`${status}-foreground`, status],
    ]),
  ];

  for (const { id } of THEMES) {
    describe(id, () => {
      const color = (name: string): Rgb => hslToRgb(blocks.get(id)!.get(name)!);

      it.each(TEXT_PAIRS)("%s on %s meets 4.5:1", (text, background) => {
        expect(contrast(color(text), color(background))).toBeGreaterThanOrEqual(4.5);
      });

      it.each(["destructive", "warning", "success", "info", "primary"])("%s text on its own light tint meets 4.5:1", (status) => {
        expect(contrast(color(status), blend(color(status), color("card"), 0.1))).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps text on glass cards at 4.5:1 at every opacity setting", () => {
        const min = Number(blocks.get(id)!.get("surface-alpha"));
        const behind = [...blocks.get(id)!.keys()].filter((name) => name.startsWith("art-")).concat("background");
        for (let step = 0; step <= 20; step++) {
          const alpha = surfaceAlpha(min, step / 20);
          for (const text of ["foreground", "muted-foreground", "primary", "destructive"]) {
            for (const art of behind) {
              expect(contrast(color(text), blend(color("card"), color(art), alpha)), `${text} over ${art} at ${alpha}`).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      });

      it("keeps text on glass cards at 4.5:1 over every color of the landscape backdrop", () => {
        const alpha = Number(blocks.get(id)!.get("surface-alpha"));
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThanOrEqual(1);
        const behind = [...blocks.get(id)!.keys()].filter((name) => name.startsWith("art-")).concat("background");
        for (const text of ["foreground", "card-foreground", "muted-foreground", "primary", "destructive", "warning", "success", "info"]) {
          for (const art of behind) {
            expect(contrast(color(text), blend(color("card"), color(art), alpha)), `${text} over ${art}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("has a focus ring that stands out from background and card (3:1)", () => {
        expect(contrast(color("ring"), color("background"))).toBeGreaterThanOrEqual(3);
        expect(contrast(color("ring"), color("card"))).toBeGreaterThanOrEqual(3);
      });
    });
  }
});

describe("theme preference", () => {
  it("accepts every theme id and system, and falls back to the default for anything else", () => {
    for (const { id } of THEMES) expect(parsePreference(id)).toBe(id);
    expect(parsePreference("system")).toBe("system");
    for (const junk of [null, undefined, "", "dark", "LIGHT", 3, {}]) expect(parsePreference(junk)).toBe(DEFAULT_PREFERENCE);
  });

  it("resolves system to Default Light or Terminal Dark", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("terminal");
    expect(resolveTheme("forest", true)).toBe("forest");
  });

  it("reads and writes through storage, surviving storage that is missing or throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readPreference(storage)).toBe(DEFAULT_PREFERENCE);
    expect(writePreference(storage, "sunset")).toBe(true);
    expect(store.get(THEME_STORAGE_KEY)).toBe("sunset");
    expect(readPreference(storage)).toBe("sunset");

    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readPreference(broken)).toBe(DEFAULT_PREFERENCE);
    expect(writePreference(broken, "minimal")).toBe(false);
    expect(readPreference(undefined)).toBe(DEFAULT_PREFERENCE);
    expect(writePreference(undefined, "minimal")).toBe(false);
  });
});

describe("index.html boot script", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  it("uses the same storage key and theme ids as the registry", () => {
    expect(script).toContain(`"${THEME_STORAGE_KEY}"`);
    const ids = /\[((?:\s*"[\w-]+",?)+)\s*\]\.indexOf/.exec(script)?.[1]?.match(/[\w-]+/g);
    expect(ids).toEqual(THEMES.map((theme) => theme.id));
  });

  it("maps system the way resolveTheme does", () => {
    expect(script).toContain(`? "${resolveTheme("system", true)}" : "${resolveTheme("system", false)}"`);
  });

  it("applies the saved theme, the system choice, and ignores junk", () => {
    const run = (saved: string | null, dark: boolean) => {
      const attributes = new Map<string, string>();
      const sandbox = {
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: dark }),
        document: { documentElement: { setAttribute: (k: string, v: string) => void attributes.set(k, v) } },
      };
      new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
      return attributes.get("data-theme");
    };
    expect(run("forest", false)).toBe("forest");
    expect(run("system", true)).toBe("terminal");
    expect(run("system", false)).toBe("light");
    expect(run("<script>", false)).toBeUndefined();
    expect(run(null, false)).toBeUndefined();
  });
});
