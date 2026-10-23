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

/** Tag characters that mirror printable ASCII: U+E0020 (space) through U+E007E (tilde). */
const TAG_ASCII_FIRST = 0xe0020;
const TAG_ASCII_LAST = 0xe007e;
const TAG_OFFSET = 0xe0000;

/**
 * Decodes Unicode tag characters back to the ASCII they smuggle (tag codepoint - 0xE0000).
 * Tags render as nothing, but models read them, so "\u{e0068}\u{e0069}" is an invisible "hi".
 * Other text, the language tag U+E0001, the cancel tag U+E007F and tags that map to ASCII
 * control characters are skipped. Returns the hidden string, or "" when there is none.
 */
export function decodeTagChars(text: string): string {
  let decoded = "";
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    if (codepoint >= TAG_ASCII_FIRST && codepoint <= TAG_ASCII_LAST) decoded += String.fromCharCode(codepoint - TAG_OFFSET);
  }
  return decoded;
}

/** Scripts a letter is checked against, in order. Letters in none of them count as "Other". */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Georgian", "Cherokee", "Hebrew", "Arabic", "Syriac", "Thaana",
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam",
  "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Mongolian", "Ethiopic", "Canadian_Aboriginal",
  "Han", "Hiragana", "Katakana", "Bopomofo", "Hangul",
].map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, "u")] as const);

/** Script-neutral characters (shared punctuation, combining marks) never make a word mixed. */
const NEUTRAL_SCRIPT = /^[\p{Script=Common}\p{Script=Inherited}]$/u;

/**
 * Script combinations that are normal in one word, from the UTS #39 "highly restrictive"
 * profile: Japanese, Chinese with Bopomofo, and Korean, each optionally with Latin.
 */
const ALLOWED_MIXES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];

/** A word: a run of letters and the combining marks attached to them. */
const WORD = /[\p{L}\p{M}]+/gu;

/** Scripts used by the letters of `word`, in order of first appearance. */
function scriptsOf(word: string): string[] {
  const scripts: string[] = [];
  for (const char of word) {
    if (NEUTRAL_SCRIPT.test(char)) continue;
    const script = SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "Other";
    if (!scripts.includes(script)) scripts.push(script);
  }
  return scripts;
}

/**
 * Why `word` could impersonate another word, or null when it is fine:
 * - it mixes scripts in a way no real language does (Latin "p" + Cyrillic "\u{430}" + "th"), or
 * - NFKC changes it beyond canonical composition (full-width "\u{ff50}ath", the "\u{fb01}" ligature,
 *   mathematical bold letters). Comparing with NFC keeps decomposed accents from counting.
 */
function confusableReason(word: string): string | null {
  const scripts = scriptsOf(word);
  if (scripts.length > 1 && !ALLOWED_MIXES.some((allowed) => scripts.every((s) => allowed.has(s)))) {
    return `mixes ${scripts.join(" + ")}`;
  }
  const folded = word.normalize("NFKC");
  return folded === word.normalize("NFC") ? null : `folds to ${escapeForEvidence(folded)} under NFKC`;
}

/**
 * Homoglyph check: words that mix scripts or change under NFKC, deduplicated, in order of first
 * appearance.
 * shortcut: a word written entirely in one look-alike script (all-Cyrillic "\u{440}\u{43e}\u{440}")
 * needs the UTS #39 confusables table to catch; add it if such names show up in practice.
 */
export function findConfusables(text: string): string[] {
  const words = new Set<string>();
  for (const [word] of text.matchAll(WORD)) {
    if (!words.has(word) && confusableReason(word) !== null) words.add(word);
  }
  return [...words];
}

/**
 * Printable-ASCII rendering of text for finding evidence, in double quotes. Anything outside
 * printable ASCII becomes [U+XXXX], so evidence can never itself hide or reorder characters.
 */
export function escapeForEvidence(text: string): string {
  let out = "";
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    out += codepoint >= 0x20 && codepoint <= 0x7e && char !== '"' ? char : `[${formatCodepoint(codepoint)}]`;
  }
  return `"${out}"`;
}

/** "U+200B", "U+E0068": at least four hex digits, uppercase. */
export function formatCodepoint(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
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
