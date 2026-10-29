import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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

/**
 * One message as a newline-terminated line. Used only for messages the proxy rewrites or
 * synthesizes; everything else is forwarded as Frame.raw. JSON.stringify escapes control
 * characters inside strings, so the result never contains a line break before the final "\n".
 *
 * @throws TypeError as JSON.stringify does (bigint values, cyclic structures).
 */
export function serialize(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Read `input` line by line and call onFrame with each parsed line, in order. A final line
 * without a terminator is delivered when the stream ends. Multi-byte UTF-8 characters split
 * across chunks are decoded correctly.
 *
 * "\n", "\r\n" and a lone "\r" all end a line (readline's rule); the terminator is not part of
 * Frame.raw, so writeLine re-terminates every forwarded line with "\n".
 *
 * Returns a function that stops the reader: no frame is delivered after it is called, even for
 * lines already buffered. Errors on `input` are left to the caller's own "error" listener.
 * onFrame runs inside the stream's data handler and must not throw.
 */
export function readFrames(input: Readable, onFrame: (frame: Frame) => void): () => void {
  // terminal: false, or a TTY stdin would get line editing and echo.
  const reader = createInterface({ input, crlfDelay: Infinity, terminal: false });
  // readline re-emits input errors on the interface; without a listener that is an uncaught
  // exception, even though the caller handles the same error on `input`.
  reader.on("error", () => {});
  let closed = false;
  // readline keeps emitting lines already split from the current chunk after close().
  reader.on("line", (line) => {
    if (!closed) onFrame(parseLine(line));
  });
  return () => {
    closed = true;
    reader.close();
  };
}

/**
 * Write one line to `output` and resolve once the stream has flushed it, so a caller that
 * awaits each write never buffers more than one line ahead of a slow reader.
 *
 * Takes either a Frame.raw (no terminator) or a serialize() result (ends in "\n") and writes it
 * with exactly one trailing "\n", in a single write so concurrent lines never interleave.
 *
 * @throws TypeError, before writing anything, when the line contains another "\n" or "\r": a
 * reader would split it into several frames, which would let one message smuggle in another.
 * Rejects with the stream's error when the write fails (destroyed or ended stream, EPIPE).
 */
export async function writeLine(output: Writable, line: string): Promise<void> {
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (/[\r\n]/.test(body)) {
    throw new TypeError("writeLine: line contains a line break and would be read as several frames");
  }
  await new Promise<void>((resolve, reject) => {
    output.write(`${body}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

/** Prefix of every variable LatchVerify itself reads. None of them is meant for the server. */
const OWN_ENV_PREFIX = "LATCH_";

/**
 * The environment a guarded server is started with: `env` merged over `base` (as MCP clients do
 * with a server's `env` block, a key set to undefined removes that variable), minus every
 * LATCH_* variable from either. Those carry the LLM API key and the paths of latch.lock and the
 * review queue, and a server that knows where its own approvals live could edit them.
 */
export function serverEnvironment(base: NodeJS.ProcessEnv, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = env === undefined ? { ...base } : { ...base, ...env };
  for (const name of Object.keys(merged)) {
    if (merged[name] === undefined || name.toUpperCase().startsWith(OWN_ENV_PREFIX)) delete merged[name];
  }
  return merged;
}

/**
 * Spawn the real server with piped stdio. Its stderr is copied to our stderr untouched (and our
 * stderr stays open when it exits); stdout is the protocol channel, so the caller wires the
 * child's stdout and stdin to readFrames and writeLine.
 *
 * No shell is involved: `command` is resolved on PATH and `args` reach the server literally.
 * The environment is serverEnvironment(process.env, env): LatchVerify's own LATCH_* variables
 * never reach the server.
 *
 * Never throws for a bad command: spawn failures (ENOENT, EACCES) arrive as the child's "error"
 * event, which the caller must handle.
 */
// shortcut: Windows cannot spawn .cmd shims (npx, pnpm) without a shell; use node plus the
// script path there, or add cross-spawn if Windows support is needed.
export function spawnUpstream(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    stdio: "pipe",
    env: serverEnvironment(process.env, env),
    windowsHide: true,
  });
  child.stderr.pipe(process.stderr, { end: false });
  return child;
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
