import type { CapabilitySet, DeclaredAnnotations, Finding, LlmAdvisory, McpTool } from "../schema/index.js";

/** Which capability a parameter name implies when it is an unconstrained string. */
export type SchemaSignal = "filesystem" | "exec" | "network" | "credentials";

/**
 * Pass 1 signal table: parameter names (case-insensitive) and the capability they imply.
 * An enum or const on the param demotes the signal to "constrained". See docs/CAPABILITIES.md.
 */
export const PARAM_SIGNALS: Readonly<Record<SchemaSignal, readonly string[]>> = {
  filesystem: ["path", "file", "filename", "filepath", "dir", "directory", "folder"],
  exec: ["command", "cmd", "script", "shell", "exec", "args"],
  network: ["url", "uri", "endpoint", "host", "webhook"],
  credentials: ["token", "apikey", "api_key", "secret", "password", "env"],
};

/** Credential words that mean "environment variables" rather than a secret value. */
const ENV_WORDS: ReadonlySet<string> = new Set(["env"]);

/** Words that turn "token" into a pagination cursor (pageToken, nextPageToken), not a secret. */
const PAGINATION_WORDS: ReadonlySet<string> = new Set(["page", "next", "continuation", "cursor"]);

/** Invisible format characters a server could use to split a name past the matcher. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Lowercase words of an identifier or sentence: splits camelCase, PascalCase, acronyms,
 * snake_case, kebab-case and punctuation, after NFKC folding and removing invisible characters.
 */
function splitWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** True when `word` is `stem` or a regular plural of it (paths, directories). */
function isFormOf(word: string, stem: string): boolean {
  if (word === stem) return true;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y" === stem;
  return word.length > 3 && word.endsWith("s") && word.slice(0, -1) === stem;
}

/** Normalized table entries: "api_key" is matched as "apikey". */
const SIGNAL_STEMS: ReadonlyArray<readonly [SchemaSignal, string]> = Object.entries(PARAM_SIGNALS).flatMap(
  ([signal, names]) => names.map((name) => [signal as SchemaSignal, splitWords(name).join("")] as const),
);

/** One matched signal: which capability and which table word triggered it. */
export interface SignalMatch {
  signal: SchemaSignal;
  word: string;
}

/**
 * Pass 1 name matching. Case-insensitive; matches each word of the parameter name and the
 * name with separators removed, so `file_path`, `targetDir`, `webhookURL` and `API_KEY` all
 * match. Plurals match their stem. "token" preceded by a pagination word (pageToken) is not a
 * credential. Returns each signal at most once, in PARAM_SIGNALS order.
 */
export function matchParamSignals(name: string): SignalMatch[] {
  const parts = splitWords(name);
  const candidates = [...parts.map((word, i) => ({ word, prev: parts[i - 1] })), { word: parts.join(""), prev: undefined }];
  const matches: SignalMatch[] = [];
  for (const [signal, stem] of SIGNAL_STEMS) {
    if (matches.some((m) => m.signal === signal)) continue;
    const hit = candidates.find(
      ({ word, prev }) =>
        isFormOf(word, stem) && !(signal === "credentials" && stem === "token" && prev !== undefined && PAGINATION_WORDS.has(prev)),
    );
    if (hit) matches.push({ signal, word: stem });
  }
  return matches;
}

/** True when a credentials match refers to environment variables rather than a secret. */
export function isEnvMatch(match: SignalMatch): boolean {
  return match.signal === "credentials" && ENV_WORDS.has(match.word);
}

/**
 * The baseline each pass widens from: every flag false, every list empty, scope "none" and
 * no declared annotations. Returns a fresh object on every call.
 */
export function emptyCapabilitySet(): CapabilitySet {
  return {
    filesystem: { read: false, write: false, scope: "none", paths: [] },
    exec: { enabled: false, shell: false },
    network: { egress: false, domains: [], unconstrained: false },
    credentials: { readsEnv: false, readsSecrets: false },
    crossServerRefs: [],
    declared: {},
  };
}

/**
 * Pass 1 (primary): deterministic schema signals.
 * TODO: walk inputSchema.properties (recursing into nested objects/arrays), match names against
 * PARAM_SIGNALS, treat params with enum/const/pattern as constrained and bare strings as
 * unconstrained, honour format "uri" as network egress. Returns the derived set with
 * crossServerRefs empty and declared {}.
 */
export function deriveFromSchema(tool: McpTool): CapabilitySet {
  throw new Error("not implemented");
}

/** Pass 2: TODO: copy readOnlyHint / destructiveHint / openWorldHint from tool.annotations as claims. */
export function readDeclared(tool: McpTool): DeclaredAnnotations {
  throw new Error("not implemented");
}

/**
 * TODO: compare declared claims with derived capabilities and return one "annotation_mismatch"
 * finding per contradiction, e.g. readOnlyHint true with filesystem.write or exec.enabled, or
 * openWorldHint false with network.egress.
 */
export function annotationMismatches(capabilities: CapabilitySet): Finding[] {
  throw new Error("not implemented");
}

/**
 * Full extraction: pass 1, then pass 2, then (if supplied) the cached pass-3 advisory.
 * TODO: merge in priority order, never letting the advisory narrow a deterministic signal,
 * and fill crossServerRefs from `knownTools` names found in the description. Returns the
 * capability set and every finding produced along the way.
 */
export function extractCapabilities(
  tool: McpTool,
  knownTools: readonly string[],
  advisory?: LlmAdvisory,
): { capabilities: CapabilitySet; findings: Finding[] } {
  throw new Error("not implemented");
}
