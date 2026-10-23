import type { McpTool, Sha256Hex, ToolHashes } from "../schema/index.js";

/**
 * TODO: deterministic JSON with object keys sorted recursively and no whitespace, so
 * semantically equal schemas hash equally regardless of key order. Returns the string.
 */
export function canonicalJson(value: unknown): string {
  throw new Error("not implemented");
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
