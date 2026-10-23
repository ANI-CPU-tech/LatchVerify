import type { CapabilitySet, DeclaredAnnotations, Finding, LlmAdvisory, McpTool } from "../schema/index.js";
import { MAX_CANONICAL_DEPTH } from "./hash.js";

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
 * NFKC-folds `text` and removes invisible characters, so full-width letters and words split by
 * zero-width characters match their plain form. Offsets in the result differ from `text`.
 */
export function foldText(text: string): string {
  return text.normalize("NFKC").replace(IGNORABLE, "");
}

/**
 * Lowercase words of an identifier or sentence: splits camelCase, PascalCase, acronyms,
 * snake_case, kebab-case and punctuation, after NFKC folding and removing invisible characters.
 */
function splitWords(text: string): string[] {
  return foldText(text)
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

/** Literal text every match of a pattern must start with. */
export interface AnchoredPrefix {
  prefix: string;
  /** True when the pattern matches exactly `prefix` and nothing longer. */
  exact: boolean;
}

const REGEX_SYNTAX = new Set([".", "^", "$", "|", "?", "*", "+", "(", ")", "[", "]", "{", "}", "\\"]);
const OPTIONAL_QUANTIFIERS = new Set(["?", "*", "{"]);

/**
 * The fixed text a JSON Schema `pattern` forces at the start of every value, or null when the
 * pattern does not pin one. Conservative by design: anything not provably fixed (no leading
 * `^`, any alternation, a class or escape like `\d` before the first literal) returns null, so
 * an unclear pattern is treated as unconstrained, never as narrower than it is.
 */
export function anchoredPrefix(pattern: string): AnchoredPrefix | null {
  if (!pattern.startsWith("^") || pattern.includes("|")) return null;
  let prefix = "";
  let i = 1;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    let literal: string;
    let width: number;
    if (ch === "\\") {
      const next = pattern[i + 1];
      // Escaped punctuation is literal; \d, \w, \u0041 and friends are classes or encodings.
      if (next === undefined || /[\p{L}\p{N}]/u.test(next)) break;
      literal = next;
      width = 2;
    } else if (REGEX_SYNTAX.has(ch)) {
      if (ch === "$" && i === pattern.length - 1) return prefix ? { prefix, exact: true } : null;
      break;
    } else {
      literal = String.fromCodePoint(pattern.codePointAt(i)!);
      width = literal.length;
    }
    const after = pattern[i + width];
    // "a?" / "a*" / "a{0,}" make this character optional, so it is not part of the fixed prefix.
    if (after !== undefined && OPTIONAL_QUANTIFIERS.has(after)) break;
    prefix += literal;
    i += width;
    if (after === "+") break;
  }
  return prefix ? { prefix, exact: false } : null;
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

/** String formats that make any parameter, whatever its name, a network destination. */
const NETWORK_FORMATS: ReadonlySet<string> = new Set(["uri", "url", "iri", "uri-template", "hostname", "idn-hostname"]);

/** Words in a tool's name or description that mean its filesystem access can write. */
const WRITE_STEMS: readonly string[] = [
  "write", "writing", "wrote", "written", "save", "saving", "delete", "deleting", "create", "creating",
  "remove", "removing", "append", "overwrite", "rename", "move", "moving", "edit", "editing", "modify",
  "mkdir", "unlink", "truncate",
];

/**
 * Upper bound on schema nodes visited while deriving one tool. A small schema can still expand
 * exponentially through chained $refs; the budget turns that into an error, not a hang.
 */
const MAX_SCHEMA_VISITS = 100_000;

type SchemaNode = Record<string, unknown>;

const isNode = (value: unknown): value is SchemaNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Own property only, so keys like "constructor" never resolve to Object.prototype members. */
const own = (node: SchemaNode, key: string): unknown => (Object.hasOwn(node, key) ? node[key] : undefined);

/** One way a parameter can receive a string. */
interface StringLeaf {
  /** Allowed values when enum or const pins them. */
  values?: string[];
  /** Fixed prefix when an anchored pattern pins one. */
  pattern?: AnchoredPrefix;
  format?: string;
  /** Reached through array items: an argv-style list rather than a single string. */
  inArray: boolean;
}

interface WalkContext {
  root: SchemaNode;
  visits: number;
}

/** Counts one node visit and enforces the nesting and work limits. */
function enter(ctx: WalkContext, depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`deriveFromSchema: schema nesting deeper than ${MAX_CANONICAL_DEPTH} levels`);
  }
  if (++ctx.visits > MAX_SCHEMA_VISITS) {
    throw new RangeError(`deriveFromSchema: schema too large (over ${MAX_SCHEMA_VISITS} nodes)`);
  }
}

/**
 * Resolves a local JSON Pointer $ref ("#", "#/$defs/x") against the tool's inputSchema.
 * Remote or malformed refs return undefined; callers treat that as "accepts anything".
 */
function resolveRef(root: SchemaNode, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(segment)) current = current[Number(segment)];
    else if (isNode(current)) current = own(current, segment);
    else return undefined;
  }
  return current;
}

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const OBJECT_KEYWORDS = ["properties", "additionalProperties", "patternProperties", "required"] as const;
const ARRAY_KEYWORDS = ["items", "prefixItems"] as const;

/**
 * Every way `node` can accept a string, directly or through array items, with the constraint
 * that applies to each. Combinator branches are unioned: over-approximating keeps the result
 * conservative (a tool is never reported narrower than its schema allows).
 */
function stringLeaves(node: unknown, inArray: boolean, ctx: WalkContext, depth: number, stack: Set<object>): StringLeaf[] {
  if (node === true) return [{ inArray }];
  if (!isNode(node) || stack.has(node)) return [];
  enter(ctx, depth);
  stack.add(node);
  try {
    const leaves: StringLeaf[] = [];
    const ref = own(node, "$ref");
    if (typeof ref === "string") {
      leaves.push(...stringLeaves(resolveRef(ctx.root, ref) ?? true, inArray, ctx, depth + 1, stack));
    }
    for (const key of COMBINATORS) {
      const branches = own(node, key);
      if (Array.isArray(branches)) {
        for (const branch of branches) leaves.push(...stringLeaves(branch, inArray, ctx, depth + 1, stack));
      }
    }

    const declared = own(node, "type");
    const types =
      typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.filter((t) => typeof t === "string") : undefined;
    const hasCombinator = typeof ref === "string" || COMBINATORS.some((k) => Array.isArray(own(node, k)));
    const looksObject = OBJECT_KEYWORDS.some((k) => Object.hasOwn(node, k));
    const looksArray = ARRAY_KEYWORDS.some((k) => Object.hasOwn(node, k));
    // Untyped schemas accept anything, unless their keywords show they are really an object or
    // an array, or they defer entirely to $ref / anyOf / oneOf / allOf.
    const untypedAny = types === undefined && !hasCombinator && !looksObject && !looksArray;
    const acceptsString = types ? types.includes("string") : untypedAny;
    const acceptsArray = types ? types.includes("array") : untypedAny || (looksArray && !looksObject);

    const format = own(node, "format");
    const base = { inArray, ...(typeof format === "string" ? { format: format.toLowerCase() } : {}) };
    const enumValues = own(node, "enum");
    const pinned = Object.hasOwn(node, "const") ? [own(node, "const")] : Array.isArray(enumValues) ? enumValues : undefined;

    if (pinned) {
      // enum / const list every accepted value, so only their string members can be strings.
      const values = pinned.filter((v): v is string => typeof v === "string");
      if (acceptsString && values.length > 0) leaves.push({ ...base, values });
    } else {
      if (acceptsString) {
        const pattern = own(node, "pattern");
        const prefix = typeof pattern === "string" ? anchoredPrefix(pattern) : null;
        leaves.push(prefix ? { ...base, pattern: prefix } : base);
      }
      if (acceptsArray) {
        const items = own(node, "items");
        const prefixItems = own(node, "prefixItems");
        if (Array.isArray(prefixItems)) {
          for (const item of prefixItems) leaves.push(...stringLeaves(item, true, ctx, depth + 1, stack));
        }
        if (Array.isArray(items)) {
          for (const item of items) leaves.push(...stringLeaves(item, true, ctx, depth + 1, stack));
        } else if (items === undefined) {
          // No items schema: the array may hold anything, strings included.
          leaves.push({ inArray: true });
        } else {
          leaves.push(...stringLeaves(items, true, ctx, depth + 1, stack));
        }
      }
    }
    return leaves;
  } finally {
    stack.delete(node);
  }
}

/** Child schemas that can declare further named properties. */
const SUBSCHEMA_KEYS = ["items", "prefixItems", "additionalProperties", "then", "else", ...COMBINATORS] as const;
// $defs / definitions are not walked directly: only definitions reached through a $ref apply.
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "dependentSchemas"] as const;

/**
 * Calls `visit` once for every named property anywhere in the schema: nested objects, array
 * items, combinator branches and $ref targets. Each node is walked once, which also stops cycles.
 */
function walkProperties(
  node: unknown,
  ctx: WalkContext,
  depth: number,
  seen: Set<object>,
  visit: (name: string, schema: unknown) => void,
): void {
  if (!isNode(node) || seen.has(node)) return;
  enter(ctx, depth);
  seen.add(node);

  const ref = own(node, "$ref");
  if (typeof ref === "string") walkProperties(resolveRef(ctx.root, ref), ctx, depth + 1, seen, visit);

  const properties = own(node, "properties");
  if (isNode(properties)) {
    for (const [name, schema] of Object.entries(properties)) visit(name, schema);
  }
  for (const key of SUBSCHEMA_KEYS) {
    const child = own(node, key);
    for (const sub of Array.isArray(child) ? child : [child]) walkProperties(sub, ctx, depth + 1, seen, visit);
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = own(node, key);
    if (isNode(map)) for (const sub of Object.values(map)) walkProperties(sub, ctx, depth + 1, seen, visit);
  }
}

/** Lowercase host of a URL ("https://Api.X.com/v1") or bare host name ("api.x.com:443"), else null. */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname) return url.hostname.toLowerCase();
  } catch {
    // Not an absolute URL; try a bare host below.
  }
  const bare = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d{1,5})?$/i.exec(value);
  if (bare && (bare[1]!.includes(".") || bare[1]!.toLowerCase() === "localhost")) return bare[1]!.toLowerCase();
  return null;
}

/**
 * Host pinned by a pattern prefix, or null. A non-exact prefix only pins the host when a
 * path, query or fragment delimiter follows it ("https://api.x.com/"): "https://api.x.com"
 * alone also matches "https://api.x.com.evil.net".
 */
function hostOfPrefix({ prefix, exact }: AnchoredPrefix): string | null {
  if (exact) return hostOf(prefix);
  const pinned = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*[/?#]/i.exec(prefix);
  return pinned ? hostOf(pinned[0]) : null;
}

/** A pattern prefix that is only a root ("/", "~/", "C:\", "./") does not narrow anything. */
const narrowsPath = (prefix: string): boolean => prefix.replace(/^(?:[a-z]:)?[\\/~.]*/i, "").length > 0;

const isConstrained = (leaf: StringLeaf): boolean => leaf.values !== undefined || leaf.pattern !== undefined;

type Scope = CapabilitySet["filesystem"]["scope"];
const SCOPE_RANK: Record<Scope, number> = { none: 0, constrained: 1, unconstrained: 2 };
const widest = (a: Scope, b: Scope): Scope => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/**
 * Pass 1 (primary): deterministic schema signals.
 *
 * Walks every named property in inputSchema (nested objects, array items, combinators, local
 * $refs) and matches names against PARAM_SIGNALS:
 * - filesystem / exec / network signals count only when the property accepts strings;
 *   enum, const or an anchored pattern makes that access "constrained", a bare string
 *   "unconstrained". Constrained paths and hosts are listed; when any access is unconstrained
 *   the lists are empty, because the tool is not limited to them.
 * - exec.shell is set when a single free-form string is accepted; argv-style arrays and fixed
 *   commands are exec without a shell.
 * - credential signals always count, whatever the type.
 * - a string with a URL or hostname format is network egress whatever its name.
 * - filesystem.write is set when the tool's name or description uses a write verb.
 *
 * Over-approximates on purpose: unclear schemas resolve to the wider reading.
 * Returns crossServerRefs empty and declared {}; later passes fill those.
 *
 * @throws RangeError when the schema is nested deeper than MAX_CANONICAL_DEPTH or expands past
 * MAX_SCHEMA_VISITS nodes.
 */
export function deriveFromSchema(tool: McpTool): CapabilitySet {
  const caps = emptyCapabilitySet();
  const paths = new Set<string>();
  const domains = new Set<string>();
  // Held in an object: the scope is widened inside closures, which TypeScript does not track for locals.
  const network: { scope: Scope } = { scope: "none" };
  const ctx: WalkContext = { root: tool.inputSchema, visits: 0 };

  const addNetwork = (leaf: StringLeaf): void => {
    caps.network.egress = true;
    const hosts = leaf.values ? leaf.values.map(hostOf) : leaf.pattern ? [hostOfPrefix(leaf.pattern)] : [];
    const pinned = leaf.values !== undefined || hosts[0] != null;
    for (const host of hosts) if (host) domains.add(host);
    network.scope = widest(network.scope, pinned ? "constrained" : "unconstrained");
  };

  walkProperties(tool.inputSchema, ctx, 0, new Set(), (name, schema) => {
    const matches = matchParamSignals(name);
    const leaves = stringLeaves(schema, false, ctx, 1, new Set());

    for (const leaf of leaves) if (leaf.format && NETWORK_FORMATS.has(leaf.format)) addNetwork(leaf);

    for (const match of matches) {
      if (match.signal === "credentials") {
        if (isEnvMatch(match)) caps.credentials.readsEnv = true;
        else caps.credentials.readsSecrets = true;
        continue;
      }
      for (const leaf of leaves) {
        if (match.signal === "filesystem") {
          caps.filesystem.read = true;
          if (leaf.values) {
            for (const value of leaf.values) paths.add(value);
            caps.filesystem.scope = widest(caps.filesystem.scope, "constrained");
          } else if (leaf.pattern && narrowsPath(leaf.pattern.prefix)) {
            paths.add(leaf.pattern.exact ? leaf.pattern.prefix : `${leaf.pattern.prefix}*`);
            caps.filesystem.scope = widest(caps.filesystem.scope, "constrained");
          } else {
            caps.filesystem.scope = "unconstrained";
          }
        } else if (match.signal === "exec") {
          caps.exec.enabled = true;
          if (!leaf.inArray && !isConstrained(leaf)) caps.exec.shell = true;
        } else {
          addNetwork(leaf);
        }
      }
    }
  });

  if (caps.filesystem.read) {
    const toolWords = splitWords(`${tool.name} ${tool.description ?? ""}`);
    caps.filesystem.write = toolWords.some((word) => WRITE_STEMS.some((stem) => isFormOf(word, stem)));
  }
  caps.filesystem.paths = caps.filesystem.scope === "constrained" ? sortedUnique(paths) : [];
  caps.network.unconstrained = network.scope === "unconstrained";
  caps.network.domains = network.scope === "constrained" ? sortedUnique(domains) : [];
  return caps;
}

const DECLARED_KEYS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;

/**
 * Pass 2: the server's annotations, copied as claims. Only boolean values are kept and absent
 * hints stay absent: MCP's defaults (not read-only, destructive, open-world) are never filled
 * in, so the record shows exactly what the server asserted.
 */
export function readDeclared(tool: McpTool): DeclaredAnnotations {
  const declared: DeclaredAnnotations = {};
  if (!tool.annotations) return declared;
  for (const key of DECLARED_KEYS) {
    const value: unknown = own(tool.annotations, key);
    if (typeof value === "boolean") declared[key] = value;
  }
  return declared;
}

/** One contradiction between a server claim and the derived capabilities. */
interface MismatchRule {
  claim: (typeof DECLARED_KEYS)[number];
  claimed: boolean;
  contradicted: (caps: CapabilitySet) => boolean;
  derived: string;
  message: string;
}

/** The claim / contradiction table from docs/CAPABILITIES.md, in a fixed order. */
const MISMATCH_RULES: readonly MismatchRule[] = [
  {
    claim: "readOnlyHint",
    claimed: true,
    contradicted: (c) => c.filesystem.write,
    derived: "filesystem.write",
    message: "Tool claims to be read-only but its filesystem access can write",
  },
  {
    claim: "readOnlyHint",
    claimed: true,
    contradicted: (c) => c.exec.enabled,
    derived: "exec.enabled",
    message: "Tool claims to be read-only but can execute commands",
  },
  {
    claim: "destructiveHint",
    claimed: false,
    contradicted: (c) => c.exec.enabled,
    derived: "exec.enabled",
    message: "Tool claims to be non-destructive but can execute commands",
  },
  {
    claim: "destructiveHint",
    claimed: false,
    contradicted: (c) => c.filesystem.write && c.filesystem.scope === "unconstrained",
    derived: "filesystem.write with unconstrained scope",
    message: "Tool claims to be non-destructive but can write anywhere on the filesystem",
  },
  {
    claim: "openWorldHint",
    claimed: false,
    contradicted: (c) => c.network.egress,
    derived: "network.egress",
    message: "Tool claims not to reach external systems but has network egress",
  },
];

/**
 * Compares the declared claims in `capabilities.declared` with the derived capabilities and
 * returns one "annotation_mismatch" finding (severity warn) per contradiction, in rule order.
 * A server that lies about being read-only is more suspicious than one that says nothing.
 */
export function annotationMismatches(capabilities: CapabilitySet): Finding[] {
  return MISMATCH_RULES.filter(
    (rule) => capabilities.declared[rule.claim] === rule.claimed && rule.contradicted(capabilities),
  ).map((rule) => ({
    type: "annotation_mismatch",
    severity: "warn",
    message: rule.message,
    evidence: `annotations.${rule.claim} = ${rule.claimed}; derived ${rule.derived}`,
  }));
}

/** Schema keys whose string values are prose the model reads. */
const PROSE_KEYS: ReadonlySet<string> = new Set(["description", "title"]);

/**
 * All prose the model sees for a tool: its title and description, plus every description and
 * title nested in inputSchema, where hidden instructions are just as effective.
 */
function toolProse(tool: McpTool): string[] {
  const texts = [tool.title, tool.description].filter((t): t is string => typeof t === "string");
  const seen = new Set<object>();
  const collect = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new RangeError(`extractCapabilities: schema nesting deeper than ${MAX_CANONICAL_DEPTH} levels`);
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && PROSE_KEYS.has(key)) texts.push(child);
      else collect(child, depth + 1);
    }
  };
  collect(tool.inputSchema, 0);
  return texts;
}

/** Characters that can be part of a tool name: a mention must not continue into one. */
const NAME_CHAR = String.raw`[\p{L}\p{N}_-]`;

/** Escapes the characters a `u`-flag RegExp treats as syntax. */
const escapeRegExp = (text: string): string => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");

/**
 * Names from `names` mentioned as whole words in `text`, deduplicated and sorted. A mention
 * must not continue into another name character, so "send_email" does not match
 * "send_email_v2". Matching is case-sensitive, like tool names; empty names are ignored.
 * `text` is matched as given: pass it through foldText first to see past invisible characters.
 */
export function findToolMentions(text: string, names: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (name.length === 0 || found.has(name)) continue;
    const mention = new RegExp(`(?<!${NAME_CHAR})${escapeRegExp(name)}(?!${NAME_CHAR})`, "u");
    if (mention.test(text)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Names from `knownTools` mentioned as whole words anywhere in the tool's prose, sorted.
 * Text is folded first, so "send_\u{200b}email" still counts. The tool's own name is never a
 * reference.
 */
function crossServerReferences(tool: McpTool, knownTools: readonly string[]): string[] {
  const prose = toolProse(tool).map(foldText).join("\n");
  return findToolMentions(prose, knownTools.filter((name) => name !== tool.name));
}

/**
 * Full extraction, in priority order. Later passes only add, never narrow:
 *
 * 1. deriveFromSchema: the deterministic schema signals.
 * 2. readDeclared: annotations stored as claims. A claim may widen the set but never narrows
 *    it: openWorldHint true adds network egress even without a URL parameter. The destination
 *    is then chosen by the server, not the model, so it is not marked unconstrained.
 *    Contradictions become annotation_mismatch findings.
 * 3. crossServerRefs: `knownTools` (tools on other servers) mentioned anywhere in the tool's
 *    prose, including descriptions nested in inputSchema.
 * 4. advisory (pass 3, optional): its findings are appended. It cannot change capabilities, so
 *    it can never narrow a deterministic signal. The caller supplies only an advisory whose
 *    cache key matches this definition (see analyze/llm.ts).
 *
 * Returns the capability set and every finding, mismatches first, then advisory findings.
 *
 * @throws RangeError for schemas nested or expanded beyond the limits of deriveFromSchema.
 */
export function extractCapabilities(
  tool: McpTool,
  knownTools: readonly string[],
  advisory?: LlmAdvisory,
): { capabilities: CapabilitySet; findings: Finding[] } {
  const capabilities = deriveFromSchema(tool);
  capabilities.declared = readDeclared(tool);
  if (capabilities.declared.openWorldHint === true) capabilities.network.egress = true;
  capabilities.crossServerRefs = crossServerReferences(tool, knownTools);

  const findings = annotationMismatches(capabilities);
  if (advisory) findings.push(...advisory.findings.map((finding) => ({ ...finding })));
  return { capabilities, findings };
}
