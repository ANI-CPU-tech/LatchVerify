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
 * TODO: JSON.parse one line; return a Frame whose message is the parsed object when it has
 * jsonrpc "2.0", or null for blank / non-JSON / non-JSON-RPC lines (still forwarded raw).
 */
export function parseLine(line: string): Frame {
  throw new Error("not implemented");
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

/** TODO: true when the message has both `method` and `id`. */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  throw new Error("not implemented");
}

/** TODO: true when the message has `method` and no `id`. */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  throw new Error("not implemented");
}

/** TODO: true when the message has `id` and no `method` (a result or error). */
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  throw new Error("not implemented");
}
