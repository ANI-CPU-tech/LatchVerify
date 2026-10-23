import type { Finding } from "../schema/index.js";

/** Inclusive codepoint range with a label used in finding evidence. */
export interface CodepointRange {
  label: string;
  from: number;
  to: number;
}

/** Invisible or direction-altering codepoints that have no business in a tool description. */
export const SUSPICIOUS_RANGES: readonly CodepointRange[] = [
  { label: "zero-width", from: 0x200b, to: 0x200d },
  { label: "word-joiner", from: 0x2060, to: 0x2064 },
  { label: "byte-order-mark", from: 0xfeff, to: 0xfeff },
  { label: "bidi-embedding", from: 0x202a, to: 0x202e },
  { label: "bidi-isolate", from: 0x2066, to: 0x2069 },
  { label: "bidi-mark", from: 0x200e, to: 0x200f },
  { label: "tag", from: 0xe0000, to: 0xe007f },
  { label: "variation-selector", from: 0xfe00, to: 0xfe0f },
  { label: "variation-selector-supplement", from: 0xe0100, to: 0xe01ef },
];

/** One suspicious codepoint occurrence. */
export interface UnicodeHit {
  label: string;
  codepoint: number;
  /** UTF-16 offset into the scanned text. */
  index: number;
}

/** TODO: scan `text` codepoint by codepoint against SUSPICIOUS_RANGES. Returns every hit in order. */
export function findSuspiciousCodepoints(text: string): UnicodeHit[] {
  throw new Error("not implemented");
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
