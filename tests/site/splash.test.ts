import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BODY, PADLOCK_COLORS, SHACKLE_CLOSED, SHACKLE_OPEN, splashHtml } from "../../site/src/art/padlock.js";
import { MAX_WAIT_MS, MIN_SHOW_MS, SEGMENTS, SPLASH_STORAGE_KEY, nextSegment } from "../../site/src/lib/splash.js";

const favicon = readFileSync(new URL("../../web/public/favicon.svg", import.meta.url), "utf8");

/** Runs the bar from empty, one tick every `tick` ms, the page loading at `loadAt` ms; returns when it fills. */
function fillTime(loadAt: number, tick = 85): number {
  let segment = 0;
  for (let t = tick; t < 60_000; t += tick) {
    segment = nextSegment(segment, t >= loadAt, t);
    if (segment === SEGMENTS) return t;
  }
  throw new Error("never filled");
}

describe("loading bar", () => {
  it("fills only once the page has loaded and the screen has shown for a moment", () => {
    expect(fillTime(0)).toBeGreaterThanOrEqual(MIN_SHOW_MS);
    expect(fillTime(0)).toBeLessThan(MIN_SHOW_MS + 300);
    expect(fillTime(2000)).toBeGreaterThanOrEqual(2000);
    expect(fillTime(2000)).toBeLessThan(2300);
  });

  it("waits short of full while loading, and never past the longest wait", () => {
    let segment = 0;
    for (let t = 85; t < MAX_WAIT_MS; t += 85) segment = nextSegment(segment, false, t);
    expect(segment).toBeLessThan(SEGMENTS);
    expect(fillTime(Number.POSITIVE_INFINITY)).toBeLessThan(MAX_WAIT_MS + 300);
  });

  it("only ever moves forward, one segment a tick", () => {
    expect(nextSegment(3, false, 10)).toBe(4);
    expect(nextSegment(SEGMENTS, false, 0)).toBe(SEGMENTS);
    expect(nextSegment(SEGMENTS - 1, true, 10)).toBe(SEGMENTS - 1);
  });
});

describe("loading screen padlock", () => {
  it("is the logo: 16 pixels wide, in the logo's own colors", () => {
    for (const row of [...BODY, ...SHACKLE_CLOSED, ...SHACKLE_OPEN]) expect(row).toMatch(/^[.oabcd]{16}$/);
    for (const color of Object.values(PADLOCK_COLORS)) expect(favicon).toContain(`fill="${color}"`);
  });

  it("opens with the left leg free and the right leg still in the body", () => {
    const below = SHACKLE_OPEN.slice(SHACKLE_CLOSED.length);
    expect(below.every((row) => row.indexOf("o") === row.lastIndexOf("o"))).toBe(true);
    expect(below.every((row) => row.indexOf("o") === SHACKLE_CLOSED[4]!.lastIndexOf("o"))).toBe(true);
  });

  it("locks onto the logo's closed shackle when dropped three rows", () => {
    expect(SHACKLE_OPEN.slice(0, SHACKLE_CLOSED.length)).toEqual(SHACKLE_CLOSED);
  });

  it("renders the shackle and the body, hidden from assistive tech", () => {
    const html = splashHtml();
    for (const part of ["splash-shackle-open", "splash-body", "splash-fill"]) expect(html).toContain(part);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("is shown once per tab by the same key in the pages and the script", () => {
    for (const page of ["index.html", "download/index.html"]) {
      const html = readFileSync(new URL(`../../site/${page}`, import.meta.url), "utf8");
      expect(html, page).toContain(`sessionStorage.getItem("${SPLASH_STORAGE_KEY}")`);
      expect(html, page).toContain("<!--lv:splash-->");
    }
  });
});
