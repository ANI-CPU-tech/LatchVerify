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

/** TODO: node:crypto SHA-256 over UTF-8 input. Returns lowercase hex. */
export function sha256Hex(input: string): Sha256Hex {
  throw new Error("not implemented");
}

/**
 * Segment hashes for one tool.
 * TODO: name = sha256(name), description = sha256(description ?? ""), inputSchema =
 * sha256(canonicalJson(inputSchema)), composite = sha256 of the three hex digests joined by
 * ":". Text is hashed as-is (no normalization) so Unicode tricks still change the hash.
 */
export function hashTool(tool: McpTool): ToolHashes {
  throw new Error("not implemented");
}
