import type { Finding } from "../schema/index.js";

/** Inclusive codepoint range with a label used in finding evidence. */
export interface CodepointRange {
  label: string;
  from: number;
  to: number;
}

/**
 * Invisible, direction-altering or control codepoints that have no business in a tool
 * description. Together the entries cover every Unicode Default_Ignorable_Code_Point (the
 * characters renderers draw as nothing) plus the C0/C1 control characters except tab, line
 * feed and carriage return. Ranges never overlap.
 */
export const SUSPICIOUS_RANGES: readonly CodepointRange[] = [
  { label: "zero-width", from: 0x200b, to: 0x200d },
  { label: "word-joiner", from: 0x2060, to: 0x2064 },
  { label: "byte-order-mark", from: 0xfeff, to: 0xfeff },
  { label: "bidi-embedding", from: 0x202a, to: 0x202e },
  { label: "bidi-isolate", from: 0x2066, to: 0x2069 },
  { label: "bidi-mark", from: 0x200e, to: 0x200f },
  { label: "bidi-mark", from: 0x061c, to: 0x061c },
  { label: "tag", from: 0xe0000, to: 0xe007f },
  { label: "variation-selector", from: 0xfe00, to: 0xfe0f },
  { label: "variation-selector", from: 0x180b, to: 0x180d },
  { label: "variation-selector", from: 0x180f, to: 0x180f },
  { label: "variation-selector-supplement", from: 0xe0100, to: 0xe01ef },
  // Remaining default-ignorable codepoints: fillers, hyphenation and formatting controls.
  { label: "invisible", from: 0x00ad, to: 0x00ad },
  { label: "invisible", from: 0x034f, to: 0x034f },
  { label: "invisible", from: 0x115f, to: 0x1160 },
  { label: "invisible", from: 0x17b4, to: 0x17b5 },
  { label: "invisible", from: 0x180e, to: 0x180e },
  { label: "invisible", from: 0x2065, to: 0x2065 },
  { label: "invisible", from: 0x206a, to: 0x206f },
  { label: "invisible", from: 0x3164, to: 0x3164 },
  { label: "invisible", from: 0xffa0, to: 0xffa0 },
  { label: "invisible", from: 0xfff0, to: 0xfff8 },
  { label: "invisible", from: 0x1bca0, to: 0x1bca3 },
  { label: "invisible", from: 0x1d173, to: 0x1d17a },
  { label: "invisible", from: 0xe0080, to: 0xe00ff },
  { label: "invisible", from: 0xe01f0, to: 0xe0fff },
  // Terminal escapes (ESC is U+001B) can hide or rewrite text when `latch review` prints it.
  { label: "control", from: 0x0000, to: 0x0008 },
  { label: "control", from: 0x000b, to: 0x000c },
  { label: "control", from: 0x000e, to: 0x001f },
  { label: "control", from: 0x007f, to: 0x009f },
];

/** One suspicious codepoint occurrence. */
export interface UnicodeHit {
  label: string;
  codepoint: number;
  /** UTF-16 offset into the scanned text. */
  index: number;
}

/** The SUSPICIOUS_RANGES entry containing `codepoint`, if any. */
export function suspiciousRange(codepoint: number): CodepointRange | undefined {
  return SUSPICIOUS_RANGES.find((range) => codepoint >= range.from && codepoint <= range.to);
}

/**
 * Scans `text` codepoint by codepoint (a surrogate pair is one codepoint) against
 * SUSPICIOUS_RANGES. Returns every hit in order of appearance, with its UTF-16 offset.
 * This is the raw scan: it applies no exemptions for legitimate emoji or joiner use.
 */
export function findSuspiciousCodepoints(text: string): UnicodeHit[] {
  const hits: UnicodeHit[] = [];
  let index = 0;
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    const range = suspiciousRange(codepoint);
    if (range) hits.push({ label: range.label, codepoint, index });
    index += char.length;
  }
  return hits;
}

/**
 * TODO: decode U+E0000 tag characters back to the ASCII they smuggle (tag char - 0xE0000).
 * Returns the hidden string, or "" when there are none.
 */
export function decodeTagChars(text: string): string {
  throw new Error("not implemented");
}

/**
 * Homoglyph check.
 * TODO: compare `text` with text.normalize("NFKC") and flag words that mix scripts (e.g. Latin
 * plus Cyrillic "а") or change under NFKC. Returns the offending words.
 */
export function findConfusables(text: string): string[] {
  throw new Error("not implemented");
}

/**
 * Run all Unicode checks over one tool field.
 * TODO: emit "unicode" findings: critical for tag chars and bidi overrides (with the decoded
 * payload as evidence), warn for zero-width runs and confusables. `field` names the source,
 * e.g. "description" or "inputSchema.properties.path.description".
 */
export function detectUnicode(text: string, field: string): Finding[] {
  throw new Error("not implemented");
}
