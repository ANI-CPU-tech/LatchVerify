import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

// Raw line-delimited JSON-RPC. Deliberately NOT the MCP SDK: a transparent
// proxy must forward fields it does not model, and SDKs normalize them away.

export type JsonRpcId = string | number | null;

/** Any JSON-RPC 2.0 message. Index signature keeps unknown fields for forwarding. */
export interface JsonRpcBase {
  jsonrpc: "2.0";
  [extra: string]: unknown;
}

export interface JsonRpcRequest extends JsonRpcBase {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification extends JsonRpcBase {
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse extends JsonRpcBase {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Which side of the proxy a message came from. */
export type Direction = "client->server" | "server->client";

/** A parsed line plus the original text, so untouched messages are forwarded byte-for-byte. */
export interface Frame {
  raw: string;
  message: JsonRpcMessage | null;
}

/**
 * Parse one line into a Frame. `raw` is always the line exactly as given, so a frame the proxy
 * does not rewrite is forwarded byte-for-byte.
 *
 * `message` is the parsed object when the line is a JSON object with `jsonrpc: "2.0"`, and null
 * for anything else: blank lines, invalid JSON, JSON that is not an object, objects without
 * the version tag, and batch arrays (MCP 2025-06-18 removed batching). Those are still
 * forwarded raw; nothing here throws on peer input.
 */
export function parseLine(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { raw: line, message: null };
  }
  const isMessage =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as { jsonrpc?: unknown }).jsonrpc === "2.0";
  return { raw: line, message: isMessage ? (parsed as JsonRpcMessage) : null };
}

/** TODO: JSON.stringify plus "\n". Used only for messages the proxy rewrites or synthesizes. */
export function serialize(message: JsonRpcMessage): string {
  throw new Error("not implemented");
}

/**
 * TODO: readline over `input`, calling onFrame for each line in order. Returns a function that
 * closes the reader.
 */
export function readFrames(input: Readable, onFrame: (frame: Frame) => void): () => void {
  throw new Error("not implemented");
}

/** TODO: write one line to `output`, respecting backpressure. Resolves when flushed. */
export async function writeLine(output: Writable, line: string): Promise<void> {
  throw new Error("not implemented");
}

/**
 * TODO: child_process.spawn the real server with piped stdio, passing stderr through to our
 * stderr untouched. Returns the child; the caller wires its stdout/stdin to readFrames/writeLine.
 */
export function spawnUpstream(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  throw new Error("not implemented");
}

// The guards check field types at runtime: parseLine only checks the version tag, so a peer can
// send `"method": 5` or `"id": {}`. Such a message matches no guard and is forwarded unchanged.
// At most one guard is true for any message.

/** A string, a number or null, as JSON-RPC 2.0 allows for `id`. */
function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

/** True when the message has a string `method` and a valid `id` (null included). */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return typeof message.method === "string" && "id" in message && isJsonRpcId(message.id);
}

/** True when the message has a string `method` and no `id` member at all. */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return typeof message.method === "string" && !("id" in message);
}

/** True when the message has a valid `id` and no `method` member (a result or an error). */
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message) && "id" in message && isJsonRpcId(message.id);
}
