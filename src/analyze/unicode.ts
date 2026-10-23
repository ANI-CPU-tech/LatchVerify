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

/** Consecutive hits with the same label: one finding each. */
interface HitRun {
  label: string;
  hits: UnicodeHit[];
  /** UTF-16 offsets: first character and one past the last. */
  start: number;
  end: number;
}

/** UTF-16 length of one codepoint. */
const unitLength = (codepoint: number): number => (codepoint > 0xffff ? 2 : 1);

/** Groups hits that touch each other and share a label. */
function groupRuns(hits: readonly UnicodeHit[]): HitRun[] {
  const runs: HitRun[] = [];
  for (const hit of hits) {
    const last = runs.at(-1);
    if (last && last.label === hit.label && last.end === hit.index) {
      last.hits.push(hit);
      last.end = hit.index + unitLength(hit.codepoint);
    } else {
      runs.push({ label: hit.label, hits: [hit], start: hit.index, end: hit.index + unitLength(hit.codepoint) });
    }
  }
  return runs;
}

/** Bidi controls that start reordering. Their closers (U+202C, U+2069) do nothing alone. */
const BIDI_OPENERS: ReadonlySet<number> = new Set([0x202a, 0x202b, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068]);

const VARIATION_LABELS: ReadonlySet<string> = new Set(["variation-selector", "variation-selector-supplement"]);

/** Longest decoded payload or affected text quoted in evidence before truncating. */
const EVIDENCE_TEXT_LIMIT = 120;

/** Escaped, quoted text for evidence, truncated with a count of what was cut. */
function quoted(text: string): string {
  const chars = [...text];
  if (chars.length <= EVIDENCE_TEXT_LIMIT) return escapeForEvidence(text);
  return `${escapeForEvidence(chars.slice(0, EVIDENCE_TEXT_LIMIT).join(""))}... (+${chars.length - EVIDENCE_TEXT_LIMIT} chars)`;
}

/** Severity and message for one run, before evidence. */
function classifyRun(run: HitRun, field: string): Pick<Finding, "severity" | "message"> {
  const count = run.hits.length;
  const chars = count === 1 ? "character" : "characters";
  switch (run.label) {
    case "tag":
      return { severity: "critical", message: `${count} invisible tag ${chars} in ${field} smuggle hidden text` };
    case "bidi-embedding":
    case "bidi-isolate":
      return run.hits.some((h) => BIDI_OPENERS.has(h.codepoint))
        ? { severity: "critical", message: `Bidirectional override in ${field} makes the text display differently from what the model reads` }
        : { severity: "warn", message: `Stray bidirectional control in ${field}` };
    case "bidi-mark":
      return { severity: "warn", message: `Bidirectional mark in ${field} can change how the text displays` };
    case "control":
      return { severity: "warn", message: `${count} control ${chars} in ${field}; terminal escapes can hide or rewrite text` };
    default:
      if (VARIATION_LABELS.has(run.label)) {
        return count > 1
          ? { severity: "critical", message: `${count} consecutive variation selectors in ${field} can encode hidden data` }
          : { severity: "warn", message: `Variation selector in ${field} without a character it applies to` };
      }
      return { severity: "warn", message: `${count} invisible ${chars} in ${field} can hide text from human reviewers` };
  }
}

/** "U+200B x8 at offset 40", plus the decoded payload or the text a bidi control affects. */
function runEvidence(run: HitRun, text: string): string {
  const codepoints = [...new Set(run.hits.map((h) => formatCodepoint(h.codepoint)))].join(",");
  const base = `${codepoints} x${run.hits.length} at offset ${run.start}`;
  if (run.label === "tag") return `${base} decodes to ${quoted(decodeTagChars(text.slice(run.start, run.end)))}`;
  if (run.hits.some((h) => BIDI_OPENERS.has(h.codepoint))) return `${base} before ${quoted(text.slice(run.end, run.end + 40))}`;
  return base;
}

/** Pictographs that a zero-width joiner legitimately fuses into one emoji. */
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;

/** Characters that attach to an emoji before a joiner: presentation selectors and skin tones. */
const EMOJI_ATTACHMENT = /^[\p{Emoji_Modifier}\u{fe0e}\u{fe0f}]$/u;

/** Combining marks, such as the Indic virama a joiner often follows. */
const MARK = /^\p{M}$/u;

/** Scripts whose spelling uses zero-width (non-)joiners between letters: Persian, Indic, Sinhala. */
const JOINING_SCRIPTS: ReadonlySet<string> = new Set([
  "Arabic", "Syriac", "Mongolian", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil",
  "Telugu", "Kannada", "Malayalam", "Sinhala", "Tibetan", "Myanmar", "Khmer",
]);

/** The whole codepoint ending just before UTF-16 offset `index`, or undefined at the start. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return pair ? text.slice(index - 2, index) : text[index - 1];
}

/** The whole codepoint starting at UTF-16 offset `index`, or undefined at the end. */
function charAt(text: string, index: number): string | undefined {
  return index < text.length ? String.fromCodePoint(text.codePointAt(index)!) : undefined;
}

/** The nearest character before `index` that is not matched by `skip`. */
function baseBefore(text: string, index: number, skip: RegExp): string | undefined {
  let char = charBefore(text, index);
  while (char !== undefined && skip.test(char)) {
    index -= char.length;
    char = charBefore(text, index);
  }
  return char;
}

const scriptOf = (char: string | undefined): string | undefined => (char === undefined ? undefined : scriptsOf(char)[0]);

/**
 * True for a single invisible character doing its normal job, which is not worth a finding:
 * - one variation selector right after a visible character ("\u{2764}\u{fe0f}", keycaps, Han
 *   ideographic variants); two or more in a row are still reported, since that encodes data;
 * - a zero-width joiner fusing two pictographs into one emoji ("\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}");
 * - a zero-width (non-)joiner between letters of a script whose spelling uses it (Persian, Indic).
 */
function isLegitimateUse(run: HitRun, text: string): boolean {
  if (run.hits.length !== 1) return false;
  const { codepoint } = run.hits[0]!;
  if (VARIATION_LABELS.has(run.label)) {
    const base = charBefore(text, run.start);
    return base !== undefined && !/^\s$/u.test(base) && suspiciousRange(base.codePointAt(0)!) === undefined;
  }
  if (codepoint !== 0x200c && codepoint !== 0x200d) return false;
  const after = charAt(text, run.end);
  if (codepoint === 0x200d) {
    const emoji = baseBefore(text, run.start, EMOJI_ATTACHMENT);
    if (emoji !== undefined && after !== undefined && PICTOGRAPH.test(emoji) && PICTOGRAPH.test(after)) return true;
  }
  const script = scriptOf(baseBefore(text, run.start, MARK));
  return script !== undefined && JOINING_SCRIPTS.has(script) && scriptOf(after) === script;
}

/**
 * Runs every Unicode check over one tool field and returns "unicode" findings: one per run of
 * suspicious codepoints, in text order, then one per confusable word.
 *
 * Severity:
 * - critical: tag characters (evidence shows the decoded payload), bidi openers (evidence shows
 *   the text they reorder), and two or more consecutive variation selectors (a byte-smuggling
 *   encoding). Critical unicode findings make a change tier 3.
 * - warn: zero-width and other invisible characters, control characters, bidi marks and stray
 *   closers, a single variation selector, and confusable words.
 *
 * A single invisible character doing its normal job (emoji presentation selector, emoji or
 * Persian/Indic joiner) is not reported; see isLegitimateUse.
 *
 * `field` names the source in messages, e.g. "description" or
 * "inputSchema.properties.path.description". Evidence is printable ASCII only.
 */
export function detectUnicode(text: string, field: string): Finding[] {
  const runs = groupRuns(findSuspiciousCodepoints(text)).filter((run) => !isLegitimateUse(run, text));
  const findings: Finding[] = runs.map((run) => ({
    type: "unicode",
    ...classifyRun(run, field),
    evidence: runEvidence(run, text),
  }));
  for (const word of findConfusables(text)) {
    findings.push({
      type: "unicode",
      severity: "warn",
      message: `Look-alike word in ${field} may impersonate other text`,
      evidence: `${escapeForEvidence(word)} ${confusableReason(word)}`,
    });
  }
  return findings;
}
