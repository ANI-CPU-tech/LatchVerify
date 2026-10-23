import type { Finding } from "../schema/index.js";
import { foldText } from "./capabilities.js";
import { escapeForEvidence } from "./unicode.js";

/**
 * Imperative phrasing aimed at the model rather than the user. Description fields describe a
 * tool; they should never instruct the agent. Matched case-insensitively.
 */
export const IMPERATIVE_PHRASES: readonly string[] = [
  "before calling",
  "before using",
  "after calling",
  "you must",
  "you should always",
  "do not tell the user",
  "don't tell the user",
  "do not mention",
  "without asking",
  "ignore previous",
  "ignore all previous",
  "disregard",
  "<important>",
  "system prompt",
];

/**
 * Sensitive filesystem locations that should never appear in a description: keys, cloud and
 * registry credentials, shell history, system account files and MCP client configs. "~/"
 * entries also match $HOME, %USERPROFILE% and /home/<user> or /Users/<user> forms, and "/"
 * matches "\" so Windows spellings count too. Matched case-insensitively.
 */
export const SENSITIVE_PATHS: readonly string[] = [
  "~/.ssh",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "~/.aws",
  "~/.config",
  "~/.gnupg",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.bash_history",
  "~/.zsh_history",
  ".env",
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "~/.cursor/mcp.json",
  "~/.claude.json",
  "claude_desktop_config.json",
];

/** Letters, digits and underscore: a word-like mention must not continue into one. */
const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;

/** Escapes the characters a `u`-flag RegExp treats as syntax. */
const escapeRegExp = (text: string): string => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");

/** Spellings of the home directory a "~/" entry also matches. */
const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|/home/[^/\\\s]+|/Users/[^/\\\s]+|/root|[a-z]:\\Users\\[^/\\\s]+)`;

/** A path separator in either style. */
const SEP = String.raw`[/\\]`;

/** RegExp source for one SENSITIVE_PATHS entry. */
function sensitivePathSource(entry: string): string {
  const home = entry.startsWith("~/");
  const body = (home ? entry.slice(2) : entry).split("/").map(escapeRegExp).join(SEP);
  // A bare name (id_rsa, .env) must stand alone: ".env" is not part of "process.env".
  const before = home || entry.startsWith("/") ? "" : `(?<!${WORD_CHAR})`;
  return `${before}${home ? `${HOME}${SEP}` : ""}${body}(?!${WORD_CHAR})`;
}

const SENSITIVE_PATTERN = new RegExp(SENSITIVE_PATHS.map(sensitivePathSource).join("|"), "giu");

/** Characters that can continue a path once a mention is found. */
const PATH_CHAR = /[^\s"'`<>()[\]{},;]/u;

/** Sentence punctuation that ends a path rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.:!?]+$/u;

/**
 * Top-level directories that make "/name" an absolute path rather than a ratio ("km/h") or
 * "and/or". Paths under other roots still count when written from the home directory.
 */
const UNIX_ROOTS = [
  "etc", "var", "usr", "home", "Users", "root", "tmp", "opt", "proc", "sys", "dev", "bin", "sbin", "lib",
  "lib64", "private", "Library", "Applications", "System", "Volumes", "mnt", "media", "srv", "run", "boot",
];

/** Absolute, home-relative and Windows drive paths. */
const GENERIC_PATH = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_./~-])/(?:${UNIX_ROOTS.join("|")})(?![\p{L}\p{N}_-])[^\s"'${"`"}<>()[\]{},;]*`,
    String.raw`(?<!${WORD_CHAR})(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)${SEP}[^\s"'${"`"}<>()[\]{},;]*`,
    String.raw`(?<!${WORD_CHAR})[a-z]:\\[^\s"'${"`"}<>()[\]{},;]*`,
  ].join("|"),
  "giu",
);

/** A located mention in folded text: UTF-16 offsets, end exclusive. */
interface Span {
  start: number;
  end: number;
}

/** Grows a span over the surrounding path characters, then drops trailing sentence punctuation. */
function widenToPath(text: string, span: Span): Span {
  let { start, end } = span;
  while (start > 0 && PATH_CHAR.test(text[start - 1]!)) start--;
  while (end < text.length && PATH_CHAR.test(text[end]!)) end++;
  const trailing = TRAILING_PUNCTUATION.exec(text.slice(start, end));
  return { start, end: trailing ? end - trailing[0].length : end };
}

/** Every match of a global RegExp as a span. */
function spans(pattern: RegExp, text: string): Span[] {
  return [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Sorts spans and merges any that overlap or touch. */
function mergeSpans(list: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...list].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Whole-path spans of sensitive locations in already-folded text. */
function sensitiveSpans(folded: string): Span[] {
  return mergeSpans(spans(SENSITIVE_PATTERN, folded).map((span) => widenToPath(folded, span)));
}

/** One finding per distinct mention text, keeping the first occurrence. */
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Context for cross-server reference detection. */
export interface PatternContext {
  /** Tool names exposed by *other* servers in the lockfile. */
  otherServerTools: readonly string[];
}

/** TODO: return "pattern" findings (warn; critical when combined with a sensitive path) for IMPERATIVE_PHRASES hits. */
export function findImperatives(text: string): Finding[] {
  throw new Error("not implemented");
}

/**
 * Filesystem paths mentioned in `text`, one "pattern" finding per distinct path in order:
 * - critical for SENSITIVE_PATHS locations (keys, credentials, client configs), however they
 *   are spelled: "~/.ssh/id_rsa", "$HOME/.aws/credentials", "C:\\Users\\me\\.ssh";
 * - warn for other absolute, home-relative or drive paths ("/var/log/app.log"). Naming a path
 *   in a description is unusual but not hostile on its own, so it is not a hard block.
 * Text is folded first, so full-width or zero-width-split spellings still match.
 */
export function findPathMentions(text: string): Finding[] {
  const folded = foldText(text);
  const sensitive = sensitiveSpans(folded);
  const overlapsSensitive = (span: Span) => sensitive.some((s) => span.start < s.end && s.start < span.end);
  const generic = spans(GENERIC_PATH, folded)
    .map((span) => widenToPath(folded, span))
    .filter((span) => span.end > span.start && !overlapsSensitive(span));

  const findings = [
    ...sensitive.map((span) => ({ span, critical: true })),
    ...generic.map((span) => ({ span, critical: false })),
  ]
    .sort((a, b) => a.span.start - b.span.start)
    .map(({ span, critical }): Finding => {
      const path = escapeForEvidence(folded.slice(span.start, span.end));
      return critical
        ? { type: "pattern", severity: "critical", message: "Text points the model at a sensitive file", evidence: path }
        : { type: "pattern", severity: "warn", message: "Text mentions a filesystem path", evidence: path };
    });
  return uniqueBy(findings, (f) => f.evidence);
}

/** TODO: return "pattern" findings for SCREAMING_SNAKE env var names, critical when they look like secrets (*_KEY, *_TOKEN, *_SECRET). */
export function findEnvVarMentions(text: string): Finding[] {
  throw new Error("not implemented");
}

/** TODO: return "cross_server" findings (critical) for each ctx.otherServerTools name mentioned in `text`. */
export function findCrossServerRefs(text: string, ctx: PatternContext): Finding[] {
  throw new Error("not implemented");
}

/** TODO: run every pattern check above over one tool field and concatenate the findings. */
export function detectPatterns(text: string, field: string, ctx: PatternContext): Finding[] {
  throw new Error("not implemented");
}
