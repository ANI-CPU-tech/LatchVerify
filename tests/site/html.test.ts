import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseScript, renderPage } from "../../site/plugin/template.js";
import { derivedRelease, releaseFields } from "../../site/src/lib/release.js";
import { THEME_COLORS, THEME_STORAGE_KEY } from "../../site/src/lib/theme.js";

const site = new URL("../../site/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, site), "utf8");
const PAGES = { "index.html": read("index.html"), "download/index.html": read("download/index.html"), "404.html": read("404.html") };
const release = derivedRelease("0.2.3", { deb: "0.2.3", arch: "0.2.3" });
const rendered = Object.fromEntries(Object.entries(PAGES).map(([path, html]) => [path, renderPage(html, release)])) as Record<keyof typeof PAGES, string>;

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
const attrs = (html: string, attr: string) => [...html.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, "g"))].map((m) => m[1]!);

/** Every source file of the site, for checks that apply to all of them. */
function siteFiles(dir: URL = site): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(html|ts|css)$/.test(entry.name) && !join(entry.parentPath, entry.name).includes(`${join("site", "dist")}`))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("site pages", () => {
  it("leave no placeholder, icon marker or art marker behind", () => {
    for (const [path, html] of Object.entries(rendered)) {
      // The embedded release JSON may hold "}}"; everything else may not.
      const markup = html.replace(/<script type="application\/json" id="lv-release">.*?<\/script>/s, "");
      expect(markup, path).not.toMatch(/\{\{|\}\}|data-icon=|<!--lv:/);
      expect(html, path).toContain('<script type="application/json" id="lv-release">');
    }
    expect(rendered["index.html"]).toContain('class="hero-art-svg"');
    expect(rendered["index.html"]).toContain('<style id="hero-motion">');
  });

  it("have a title, a description, a canonical address and one h1 each", () => {
    for (const [path, html] of Object.entries(PAGES)) {
      expect(html, path).toMatch(/<html lang="en"/);
      expect(html, path).toMatch(/<title>[^<]{10,}<\/title>/);
      expect(html, path).toContain('name="viewport"');
      expect(html.match(/<h1[\s>]/g), path).toHaveLength(1);
      if (path === "404.html") expect(html).toContain('name="robots" content="noindex"');
      else {
        expect(html, path).toMatch(/<meta\s+name="description"\s+content="[^"]{50,}"/);
        expect(html, path).toContain(`<link rel="canonical" href="https://ani-cpu-tech.github.io/LatchVerify/${path.replace("index.html", "")}" />`);
      }
    }
  });

  it("use each id once, and link only to ids that exist", () => {
    const pageIds = Object.fromEntries(Object.entries(rendered).map(([path, html]) => [path, ids(html)]));
    for (const [path, list] of Object.entries(pageIds)) expect(new Set(list).size, `${path} has a duplicate id`).toBe(list.length);
    for (const [path, html] of Object.entries(rendered)) {
      for (const href of attrs(html, "href")) {
        const match = /^((?:\.\.\/|\.\/|download\/)?)#(.+)$/.exec(href);
        if (!match) continue;
        // "#id" and "./#id" stay on the page; "../#id" is the home page, "download/#id" the download page.
        const page = match[1] === "../" ? "index.html" : match[1] === "download/" ? "download/index.html" : path;
        expect(pageIds[page], `${path}: ${href}`).toContain(match[2]);
      }
      for (const control of attrs(html, "aria-controls")) expect(pageIds[path as keyof typeof rendered], `${path}: aria-controls ${control}`).toContain(control);
      for (const target of attrs(html, "data-copy")) expect(pageIds[path as keyof typeof rendered], `${path}: data-copy ${target}`).toContain(target);
    }
  });

  it("pair every tab with its panel", () => {
    for (const [path, html] of Object.entries(rendered)) {
      for (const [tab] of html.matchAll(/<button[^>]*role="tab"[^>]*>/g)) {
        const id = /id="([^"]+)"/.exec(tab)![1]!;
        const panel = /aria-controls="([^"]+)"/.exec(tab)![1]!;
        expect(html, `${path}: panel ${panel}`).toMatch(new RegExp(`role="tabpanel" id="${panel}" aria-labelledby="${id}"`));
      }
    }
  });

  it("open external links safely and give every image an alt", () => {
    for (const [path, html] of Object.entries(rendered)) {
      for (const [anchor] of html.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) expect(anchor, path).toMatch(/rel="[^"]*noopener/);
      for (const [img] of html.matchAll(/<img\s[^>]*>/g)) expect(img, path).toMatch(/\salt="/);
    }
  });

  it("only mark fields the release data has", () => {
    const fields = releaseFields(release);
    for (const [path, html] of Object.entries(PAGES)) {
      for (const [, file, field] of html.matchAll(/data-file="([^"]+)" data-field="([^"]+)"/g)) expect(fields.has(`file.${file}.${field}`), `${path}: ${file}.${field}`).toBe(true);
      for (const field of attrs(html, "data-release")) expect(fields.has(`release.${field}`), `${path}: release.${field}`).toBe(true);
    }
  });

  it("apply the theme before first paint with the same key, rule and colors as src/lib/theme.ts", () => {
    for (const [path, html] of Object.entries(PAGES)) {
      const boot = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
      expect(boot, path).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
      expect(boot, path).toContain('theme !== "light" && theme !== "dark"');
      expect(boot, path).toContain('matchMedia("(prefers-color-scheme: dark)")');
      expect(boot, path).toContain(`theme === "dark" ? "${THEME_COLORS.dark}" : "${THEME_COLORS.light}"`);
      expect(html, path).toContain(`<meta name="theme-color" content="${THEME_COLORS.light}" />`);
    }
  });

  it("use emoji nowhere: the pixel icons and plain text carry everything", () => {
    for (const file of siteFiles()) {
      const text = readFileSync(file, "utf8");
      // A pictograph is allowed only with the text-presentation selector after it (the CLI's check and cross marks).
      const emoji = [...text.matchAll(/\p{Extended_Pictographic}(?!︎|&#xFE0E;)/gu)].map((m) => m[0]);
      expect(emoji, file).toEqual([]);
    }
  });

  it("ship the app's own favicon", () => {
    expect(read("public/favicon.svg")).toBe(readFileSync(new URL("../../web/public/favicon.svg", import.meta.url), "utf8"));
  });
});

describe("page template", () => {
  it("fails the build on an unknown placeholder or icon", () => {
    expect(() => renderPage("<p>{{release.colour}}</p>", release)).toThrow(/unknown placeholder \{\{release\.colour\}\}/);
    expect(() => renderPage('<i data-icon="rocket"></i>', release)).toThrow(/unknown icon "rocket"/);
    expect(() => renderPage('<i class="x" data-icon="lock"></i>', release)).toThrow(/icon placeholder not in the form/);
  });

  it("escapes what it inserts", () => {
    const odd = { ...release, url: 'https://github.com/ANI-CPU-tech/LatchVerify/releases/tag/v0.2.3?"<x>' };
    expect(renderPage('<a href="{{release.url}}">', odd)).toContain("?&quot;&lt;x&gt;");
    expect(releaseScript({ ...release, version: "</script><script>alert(1)</script>" })).not.toMatch(/<\/script><script>/);
  });
});
