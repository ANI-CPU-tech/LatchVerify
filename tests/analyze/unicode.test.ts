import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUSPICIOUS_RANGES, findSuspiciousCodepoints, suspiciousRange } from "../../src/analyze/unicode.js";
import { McpToolListSchema, type McpTool } from "../../src/schema/index.js";

const fixtureTools = (name: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

const description = (file: string, tool: string): string => fixtureTools(file).find((t) => t.name === tool)!.description!;

describe("SUSPICIOUS_RANGES", () => {
  it("has well-formed, non-overlapping ranges", () => {
    for (const range of SUSPICIOUS_RANGES) expect(range.from).toBeLessThanOrEqual(range.to);
    const sorted = [...SUSPICIOUS_RANGES].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.from).toBeGreaterThan(sorted[i - 1]!.to);
  });

  it("covers every Unicode default-ignorable codepoint", () => {
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(cp)) && !suspiciousRange(cp)) {
        missing.push(cp.toString(16));
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers control characters except tab, line feed and carriage return", () => {
    for (const cp of [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f, 0x85, 0x9b, 0x9f]) {
      expect(suspiciousRange(cp)?.label).toBe("control");
    }
    for (const cp of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7e, 0xa0]) expect(suspiciousRange(cp)).toBeUndefined();
  });

  it("does not cover ordinary letters, digits, punctuation or emoji", () => {
    for (const char of ["a", "Z", "0", " ", "~", "\u{e9}", "\u{430}", "\u{4e2d}", "\u{1f600}", "\u{2764}"]) {
      expect(suspiciousRange(char.codePointAt(0)!)).toBeUndefined();
    }
  });
});

describe("findSuspiciousCodepoints", () => {
  it("returns nothing for empty or ordinary text", () => {
    expect(findSuspiciousCodepoints("")).toEqual([]);
    expect(findSuspiciousCodepoints("Get the weather forecast.\n\tTabs and newlines are fine.")).toEqual([]);
  });

  it("returns every hit in order with its label, codepoint and UTF-16 offset", () => {
    expect(findSuspiciousCodepoints("a\u{200b}b\u{202e}c\u{2060}")).toEqual([
      { label: "zero-width", codepoint: 0x200b, index: 1 },
      { label: "bidi-embedding", codepoint: 0x202e, index: 3 },
      { label: "word-joiner", codepoint: 0x2060, index: 5 },
    ]);
  });

  it("iterates by codepoint, so astral characters are one unit and offsets stay in UTF-16", () => {
    expect(findSuspiciousCodepoints("\u{1f600}\u{200b}\u{e0068}x\u{e0069}")).toEqual([
      { label: "zero-width", codepoint: 0x200b, index: 2 },
      { label: "tag", codepoint: 0xe0068, index: 3 },
      { label: "tag", codepoint: 0xe0069, index: 6 },
    ]);
  });

  it("flags terminal escape sequences", () => {
    expect(findSuspiciousCodepoints("ok\u001b[8mhidden\u001b[0m").map((h) => h.index)).toEqual([2, 12]);
  });

  it("finds nothing in the benign fixture", () => {
    for (const tool of fixtureTools("benign-tools.json")) {
      expect(findSuspiciousCodepoints(tool.description ?? "")).toEqual([]);
      expect(findSuspiciousCodepoints(JSON.stringify(tool))).toEqual([]);
    }
  });

  it("finds the zero-width run, bidi override and tag characters in the poisoned fixture", () => {
    const forecast = findSuspiciousCodepoints(description("poisoned-tools.json", "get_forecast"));
    expect(forecast).toHaveLength(8);
    expect(forecast.every((h) => h.codepoint === 0x200b)).toBe(true);
    expect(forecast.map((h) => h.index)).toEqual([40, 41, 42, 43, 44, 45, 46, 47]);

    expect(findSuspiciousCodepoints(description("poisoned-tools.json", "run_diagnostics")).map((h) => h.codepoint)).toEqual([
      0x202e, 0x202c,
    ]);
    expect(findSuspiciousCodepoints(description("poisoned-tools.json", "sync_alerts")).map((h) => h.codepoint)).toEqual([
      0xe0068, 0xe0069,
    ]);
  });
});
