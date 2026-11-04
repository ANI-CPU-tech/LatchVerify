import { createHash } from "node:crypto";
import type { McpTool, Sha256Hex, ToolHashes } from "../schema/index.js";

/**
 * Deepest nesting canonicalJson accepts. Real tool schemas are a few levels deep; the limit
 * turns a hostile, absurdly nested inputSchema into a clear error instead of a stack overflow.
 */
export const MAX_CANONICAL_DEPTH = 256;

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, so semantically equal
 * schemas serialize (and hash) identically regardless of key order.
 *
 * Follows RFC 8785 (JCS) ordering and serialization: keys sorted by UTF-16 code units,
 * numbers and strings serialized exactly as JSON.stringify does. Undefined object members are
 * omitted and undefined array slots become null, matching JSON.stringify.
 *
 * @throws TypeError for values JSON cannot represent (non-finite numbers, bigint, functions,
 * symbols, non-plain objects such as Date or Map) and for cyclic structures.
 * @throws RangeError when nesting exceeds MAX_CANONICAL_DEPTH.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("canonicalJson: undefined is not representable in JSON");
  }
  return serialize(value, new Set());
}

/** `ancestors` holds the containers on the current path: cycle detection and depth in one. */
function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${value} is not representable in JSON`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not representable in JSON`);
  }

  if (ancestors.has(value)) throw new TypeError("canonicalJson: cyclic structure");
  if (ancestors.size >= MAX_CANONICAL_DEPTH) {
    throw new RangeError(`canonicalJson: nesting deeper than ${MAX_CANONICAL_DEPTH} levels`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Array.from visits holes too, so sparse arrays serialize like JSON.stringify.
      const items = Array.from(value, (item: unknown) => (item === undefined ? "null" : serialize(item, ancestors)));
      return `[${items.join(",")}]`;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      throw new TypeError(`canonicalJson: unsupported object type ${name}`);
    }

    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Matches an unpaired surrogate: with the `u` flag, valid pairs are read as one code point. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

/** 0xFF never occurs in UTF-8, so prefixing it cannot collide with any well-formed string. */
const ILL_FORMED_MARKER = Uint8Array.of(0xff);

/**
 * SHA-256 of a string as lowercase hex.
 *
 * Well-formed strings are hashed as their UTF-8 bytes. UTF-8 cannot encode lone surrogates
 * (Node silently substitutes U+FFFD, which would make "\ud800" and "\ufffd" collide), so an
 * ill-formed string is hashed as 0xFF followed by the UTF-8 of its JSON-escaped form. The
 * encoding is injective: distinct strings never share an input byte sequence.
 */
export function sha256Hex(input: string): Sha256Hex {
  const hash = createHash("sha256");
  if (LONE_SURROGATE.test(input)) {
    hash.update(ILL_FORMED_MARKER).update(JSON.stringify(input), "utf8");
  } else {
    hash.update(input, "utf8");
  }
  return hash.digest("hex");
}

/**
 * Segment hashes for one tool, as pinned in latch.lock (format: docs/LOCKFILE.md).
 *
 * - name:        sha256(name)
 * - description: sha256(description ?? "")
 * - inputSchema: sha256(canonicalJson(inputSchema))
 * - metadata:    sha256(canonicalJson({ title, annotations })), absent fields omitted
 * - composite:   sha256 of the four hex digests joined by ":"
 *
 * Text is hashed as-is, without Unicode normalization, so zero-width or confusable characters
 * still change the hash. The title and annotations are pinned too: clients show the title to the
 * model, so a rug pull can hide instructions there, and a flipped readOnlyHint is a changed claim.
 * Vendor extension fields are not pinned.
 *
 * @throws as canonicalJson does, if inputSchema holds values JSON cannot represent.
 */
export function hashTool(tool: McpTool): ToolHashes {
  const name = sha256Hex(tool.name);
  const description = sha256Hex(tool.description ?? "");
  const inputSchema = sha256Hex(canonicalJson(tool.inputSchema));
  const metadata = sha256Hex(canonicalJson({ title: tool.title, annotations: tool.annotations }));
  return { name, description, inputSchema, metadata, composite: sha256Hex(`${name}:${description}:${inputSchema}:${metadata}`) };
}

/**
 * The hash latch.lock keeps of how a server is started: sha256 of the canonical JSON of
 * [command, ...args]. latch.lock goes to git, and a server's arguments may hold a key
 * (`--token ...`), so the launch line itself is never stored; this hash still ties the pins to
 * exactly one launch.
 */
export function launchHash(command: string, args: readonly string[]): Sha256Hex {
  return sha256Hex(canonicalJson([command, ...args]));
}

/** The program a launch runs, for people: the command's file name ("npx", "node.exe"), never its directory or arguments. */
export function programName(command: string): string {
  return command.split(/[\\/]/).pop() || command;
}
