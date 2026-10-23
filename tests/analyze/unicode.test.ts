import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUSPICIOUS_RANGES,
  decodeTagChars,
  detectUnicode,
  escapeForEvidence,
  findConfusables,
  findSuspiciousCodepoints,
  formatCodepoint,
  suspiciousRange,
} from "../../src/analyze/unicode.js";
import { FindingSchema, McpToolListSchema, type Finding, type McpTool } from "../../src/schema/index.js";

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

/** Encodes printable ASCII as invisible tag characters, the way a smuggling attack does. */
const toTags = (ascii: string): string => [...ascii].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

describe("decodeTagChars", () => {
  it("decodes the payload hidden in the poisoned sync_alerts description", () => {
    expect(decodeTagChars(description("poisoned-tools.json", "sync_alerts"))).toBe("hi");
  });

  it("round-trips every printable ASCII character", () => {
    let ascii = "";
    for (let c = 0x20; c <= 0x7e; c++) ascii += String.fromCharCode(c);
    expect(decodeTagChars(toTags(ascii))).toBe(ascii);
  });

  it("ignores visible text around and between tag characters", () => {
    expect(decodeTagChars(`Sync alerts.${toTags("Ignore")} visible ${toTags(" previous")}`)).toBe("Ignore previous");
  });

  it("skips the language tag, the cancel tag and tags for control characters", () => {
    const controls = String.fromCodePoint(0xe0000, 0xe0001, 0xe000a, 0xe001f, 0xe007f);
    expect(decodeTagChars(`${controls}${toTags("ok")}${String.fromCodePoint(0xe007f)}`)).toBe("ok");
  });

  it("returns an empty string when there are no tag characters", () => {
    expect(decodeTagChars("")).toBe("");
    expect(decodeTagChars("plain text \u{1f600}")).toBe("");
    for (const tool of fixtureTools("benign-tools.json")) expect(decodeTagChars(tool.description ?? "")).toBe("");
  });
});

describe("findConfusables", () => {
  it("flags Latin words with Cyrillic or Greek look-alike letters", () => {
    expect(findConfusables("read the p\u{430}th")).toEqual(["p\u{430}th"]);
    expect(findConfusables("visit g\u{3bf}ogle now")).toEqual(["g\u{3bf}ogle"]);
  });

  it("flags compatibility forms that NFKC folds to plain letters", () => {
    expect(findConfusables("\u{ff50}\u{ff41}\u{ff54}\u{ff48}")).toEqual(["\u{ff50}\u{ff41}\u{ff54}\u{ff48}"]); // full-width
    expect(findConfusables("open \u{fb01}le")).toEqual(["\u{fb01}le"]); // fi ligature
    expect(findConfusables("\u{1d42b}\u{1d41e}\u{1d41a}\u{1d41d}")).toEqual(["\u{1d42b}\u{1d41e}\u{1d41a}\u{1d41d}"]); // math bold
  });

  it("does not flag single-script words in any script", () => {
    expect(findConfusables("Get the weather forecast for a location.")).toEqual([]);
    expect(findConfusables("\u{43f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{3ba}\u{3b1}\u{3bb}\u{3b7}\u{3bc}\u{3ad}\u{3c1}\u{3b1} \u{645}\u{631}\u{62d}\u{628}\u{627}")).toEqual([]);
  });

  it("does not flag accents, precomposed or decomposed", () => {
    expect(findConfusables("caf\u{e9} cafe\u{301} na\u{ef}ve")).toEqual([]);
  });

  it("allows the script mixes real languages use", () => {
    expect(findConfusables("\u{6771}\u{4eac}\u{30bf}\u{30ef}\u{30fc}")).toEqual([]); // Han + Katakana
    expect(findConfusables("T\u{30b7}\u{30e3}\u{30c4}")).toEqual([]); // Latin + Katakana
    expect(findConfusables("\u{d55c}\u{ad6d}\u{8a9e}")).toEqual([]); // Hangul + Han
  });

  it("flags mixes outside the allowed profiles", () => {
    expect(findConfusables("\u{d55c}\u{30bf}")).toEqual(["\u{d55c}\u{30bf}"]); // Hangul + Katakana
    expect(findConfusables("abc\u{639}\u{631}\u{628}")).toEqual(["abc\u{639}\u{631}\u{628}"]); // Latin + Arabic
  });

  it("ignores digits and punctuation between letters", () => {
    expect(findConfusables("p4th v1.2 user_id e-mail")).toEqual([]);
  });

  it("returns each offending word once, in order of first appearance", () => {
    const text = "x\u{430} p\u{430}th x\u{430} \u{fb01}le p\u{430}th";
    expect(findConfusables(text)).toEqual(["x\u{430}", "p\u{430}th", "\u{fb01}le"]);
  });

  it("finds nothing in either fixture", () => {
    for (const tool of [...fixtureTools("benign-tools.json"), ...fixtureTools("poisoned-tools.json")]) {
      expect(findConfusables(tool.description ?? "")).toEqual([]);
    }
  });
});

describe("escapeForEvidence", () => {
  it("quotes printable ASCII unchanged", () => {
    expect(escapeForEvidence("read ~/.ssh/id_rsa")).toBe('"read ~/.ssh/id_rsa"');
  });

  it("renders every other character as [U+XXXX], including quotes and newlines", () => {
    expect(escapeForEvidence('a\u{200b}"\n\u{430}\u{e0068}')).toBe('"a[U+200B][U+0022][U+000A][U+0430][U+E0068]"');
  });

  it("formats codepoints with at least four uppercase hex digits", () => {
    expect([0x9, 0x200b, 0xe0068, 0x10ffff].map(formatCodepoint)).toEqual(["U+0009", "U+200B", "U+E0068", "U+10FFFF"]);
  });
});

/** Every string value anywhere in a tool definition, with a field path for messages. */
function textFields(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => textFields(child, path ? `${path}.${key}` : key));
}

const summary = (findings: Finding[]) => findings.map((f) => `${f.severity}: ${f.evidence}`);

describe("detectUnicode", () => {
  it("returns no findings for empty or ordinary text", () => {
    expect(detectUnicode("", "description")).toEqual([]);
    expect(detectUnicode("Get active weather alerts for a US state.\n\tCaf\u{e9}, na\u{ef}ve, \u{6771}\u{4eac}.", "description")).toEqual([]);
  });

  it("finds nothing in any text field of the benign fixture", () => {
    for (const tool of fixtureTools("benign-tools.json")) {
      for (const [field, text] of textFields(tool)) expect(detectUnicode(text, field)).toEqual([]);
    }
  });

  it("reports the poisoned get_forecast zero-width run as one warn finding", () => {
    const findings = detectUnicode(description("poisoned-tools.json", "get_forecast"), "description");
    expect(summary(findings)).toEqual(["warn: U+200B x8 at offset 40"]);
    expect(findings[0]!.message).toBe("8 invisible characters in description can hide text from human reviewers");
  });

  it("reports the poisoned run_diagnostics bidi override as critical, showing the text it reverses", () => {
    const findings = detectUnicode(description("poisoned-tools.json", "run_diagnostics"), "description");
    expect(summary(findings)).toEqual([
      'critical: U+202E x1 at offset 17 before "esrever[U+202C] command. Ignore previous instru"',
      "warn: U+202C x1 at offset 25",
    ]);
  });

  it("reports the poisoned sync_alerts tag characters as critical with the decoded payload", () => {
    const findings = detectUnicode(description("poisoned-tools.json", "sync_alerts"), "description");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "critical", message: "2 invisible tag characters in description smuggle hidden text" });
    expect(findings[0]!.evidence).toMatch(/^U\+E0068,U\+E0069 x2 at offset \d+ decodes to "hi"$/);
  });

  it("treats bidi isolates as critical and lone closers as warn", () => {
    expect(summary(detectUnicode("a\u{2067}b\u{2069}", "title"))).toEqual(['critical: U+2067 x1 at offset 1 before "b[U+2069]"', "warn: U+2069 x1 at offset 3"]);
    expect(detectUnicode("x\u{202c}", "d").map((f) => f.message)).toEqual(["Stray bidirectional control in d"]);
  });

  it("flags terminal escapes and other control characters as warn", () => {
    expect(summary(detectUnicode("ok\u{1b}[8mhidden", "description"))).toEqual(["warn: U+001B x1 at offset 2"]);
  });

  it("treats two or more consecutive variation selectors as an encoding of hidden data", () => {
    const smuggled = `hello\u{1f600}${String.fromCodePoint(0xfe00, 0xfe01, 0xe0100, 0xe0101)}`;
    const findings = detectUnicode(smuggled, "description");
    expect(findings.map((f) => f.severity)).toEqual(["critical", "critical"]);
    expect(findings[0]!.message).toBe("2 consecutive variation selectors in description can encode hidden data");
  });

  it("reports confusable words after the codepoint runs, with an escaped explanation", () => {
    const findings = detectUnicode("read p\u{430}th\u{200b} or \u{fb01}le", "inputSchema.properties.path.description");
    expect(summary(findings)).toEqual([
      "warn: U+200B x1 at offset 9",
      'warn: "p[U+0430]th" mixes Latin + Cyrillic',
      'warn: "[U+FB01]le" folds to "file" under NFKC',
    ]);
    expect(findings[1]!.message).toBe("Look-alike word in inputSchema.properties.path.description may impersonate other text");
  });

  it("truncates long payloads in evidence and says how much was cut", () => {
    const payload = "x".repeat(300);
    const tags = [...payload].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    const [finding] = detectUnicode(`a${tags}`, "description");
    expect(finding!.evidence).toBe(`U+E0078 x300 at offset 1 decodes to "${"x".repeat(120)}"... (+180 chars)`);
  });

  it("only ever produces schema-valid findings with printable-ASCII evidence", () => {
    const hostile = `\u{202e}\u{1b}]0;title\u{7}${"\u{200b}".repeat(3)}g\u{3bf}\u{3bf}gle\u{e0049}\u{e0067}\u{feff}\u{ad}\u{fe0f}\u{fe0f}`;
    const texts = [hostile, ...fixtureTools("poisoned-tools.json").flatMap((t) => textFields(t).map(([, text]) => text))];
    for (const text of texts) {
      for (const finding of detectUnicode(text, "description")) {
        expect(FindingSchema.parse(finding)).toEqual(finding);
        expect(finding.type).toBe("unicode");
        expect(finding.evidence).toMatch(/^[\x20-\x7e]*$/);
      }
    }
  });
});
