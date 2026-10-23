// Benign demo MCP server: two read-only weather tools over stdio.
// Speaks raw line-delimited JSON-RPC, like the proxy, so the demo has no SDK dependency.
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import benign from "../tests/fixtures/benign-tools.json" with { type: "json" };
import {
  isNotification,
  isRequest,
  isResponse,
  readFrames,
  serialize,
  writeLine,
  type Frame,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/proxy/transport.js";
import { McpToolListSchema, type McpTool } from "../src/schema/index.js";

export const TOOLS: McpTool[] = McpToolListSchema.parse(benign).tools;

/** MCP revision the demo servers speak. */
export const PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC 2.0 error codes the demo servers answer with. */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** One tools/call result: text for the model, or a JSON-RPC error when the call is invalid. */
export type CallOutcome = { text: string } | { error: JsonRpcErrorObject };

/** What a demo server serves. `tools` and `call` are consulted per request, so they may change. */
export interface DemoServer {
  /** serverInfo reported by initialize. */
  info: { name: string; version: string };
  /** Prefix for stderr log lines. */
  logName: string;
  tools(): readonly McpTool[];
  call(name: string, args: Record<string, unknown>): CallOutcome;
}

/** Write one diagnostic line to stderr. stdout carries only JSON-RPC. */
export function log(logName: string, message: string): void {
  process.stderr.write(`[${logName}] ${message}\n`);
}

/**
 * The reply to one frame, or null when none is due.
 *
 * Requests get a result or an error. Notifications (known or not), responses and blank lines
 * get nothing, as JSON-RPC 2.0 requires. A line that is not JSON gets a parse error, and JSON
 * that is not a single valid message (including a batch, which MCP 2025-06-18 removed) gets
 * an invalid-request error, both with a null id.
 */
export function reply(server: DemoServer, frame: Frame): JsonRpcResponse | null {
  const { message } = frame;
  if (message === null) {
    if (frame.raw.trim() === "") return null;
    return isJson(frame.raw)
      ? errorResponse(null, RPC_ERROR.invalidRequest, "Invalid Request: expected one JSON-RPC 2.0 message")
      : errorResponse(null, RPC_ERROR.parseError, "Parse error: line is not valid JSON");
  }
  if (isRequest(message)) return dispatch(server, message);
  if (isNotification(message) || isResponse(message)) return null;
  // No guard matched, so `method` or `id` has the wrong type; the cast undoes TS's narrowing.
  const id = validId((message as JsonRpcMessage).id);
  return errorResponse(id, RPC_ERROR.invalidRequest, "Invalid Request: malformed method or id");
}

function dispatch(server: DemoServer, request: JsonRpcRequest): JsonRpcResponse {
  switch (request.method) {
    case "initialize":
      return result(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: server.info,
      });
    case "ping":
      return result(request.id, {});
    case "tools/list":
      return result(request.id, { tools: server.tools() });
    case "tools/call":
      return callTool(server, request);
    default:
      return errorResponse(request.id, RPC_ERROR.methodNotFound, `Method not found: ${request.method}`);
  }
}

function callTool(server: DemoServer, request: JsonRpcRequest): JsonRpcResponse {
  const params = request.params;
  if (!isPlainObject(params) || typeof params.name !== "string") {
    return errorResponse(request.id, RPC_ERROR.invalidParams, "Invalid params: tools/call needs a string name");
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isPlainObject(args)) {
    return errorResponse(request.id, RPC_ERROR.invalidParams, "Invalid params: arguments must be an object");
  }
  let outcome: CallOutcome;
  try {
    outcome = server.call(params.name, args);
  } catch (error) {
    log(server.logName, `tool ${params.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(request.id, RPC_ERROR.internalError, "Internal error");
  }
  if ("error" in outcome) return { jsonrpc: "2.0", id: request.id, error: outcome.error };
  return result(request.id, { content: [{ type: "text", text: outcome.text }], isError: false });
}

/** A JSON-RPC error for a tools/call naming a tool this server does not have. */
export function unknownTool(name: string): CallOutcome {
  return { error: { code: RPC_ERROR.invalidParams, message: `Unknown tool: ${name}` } };
}

/** A JSON-RPC error for tools/call arguments that do not fit the tool's inputSchema. */
export function invalidArguments(tool: string, problem: string): CallOutcome {
  return { error: { code: RPC_ERROR.invalidParams, message: `Invalid arguments for ${tool}: ${problem}` } };
}

/** A running stdio session. */
export interface StdioSession {
  /** Queue a server-initiated message; it is written after every reply already queued. */
  send(message: JsonRpcMessage): void;
  /** Resolves once input has ended and every queued line is flushed; rejects if output failed. */
  closed: Promise<void>;
}

/**
 * Serve `server` over line-delimited JSON-RPC: one frame per input line, replies in request
 * order. `afterReply` runs after each request's reply is queued, so a message it sends always
 * follows that reply on the wire.
 *
 * When output fails (the client went away), reading stops and `closed` rejects with the error.
 */
export function serveStdio(
  server: DemoServer,
  hooks: { afterReply?(request: JsonRpcRequest, session: StdioSession): void } = {},
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): StdioSession {
  let outputError: unknown;
  let flushed = Promise.resolve();
  let stopReading = () => {};
  let inputEnded!: () => void;
  const ended = new Promise<void>((resolve) => (inputEnded = resolve));

  const fail = (error: unknown) => {
    outputError ??= error;
    stopReading();
    inputEnded();
  };
  // writeLine rejects on failure too; without this listener the same error would also crash.
  output.on("error", fail);

  const send = (message: JsonRpcMessage) => {
    if (outputError !== undefined) return;
    const line = serialize(message);
    flushed = flushed.then(() => writeLine(output, line)).catch(fail);
  };

  const session: StdioSession = {
    send,
    closed: ended
      .then(() => flushed)
      .then(() => {
        output.off("error", fail);
        if (outputError !== undefined) throw outputError;
      }),
  };

  stopReading = readFrames(input, (frame) => {
    if (outputError !== undefined) return;
    const response = reply(server, frame);
    if (response !== null) send(response);
    if (frame.message !== null && isRequest(frame.message)) hooks.afterReply?.(frame.message, session);
  });
  // Registered after readFrames, so readline has delivered a final unterminated line by now.
  input.once("end", () => inputEnded());
  input.once("close", () => inputEnded());
  input.once("error", fail);
  return session;
}

/**
 * True when the module at `moduleUrl` is the script node (or tsx) was started with, so a server
 * starts only when run directly and never when a test imports its exports.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function validId(id: unknown): JsonRpcId {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * TODO: readline over stdin; answer `initialize` (protocolVersion "2025-06-18", capabilities
 * { tools: { listChanged: true } }), `tools/list` with TOOLS, and `tools/call` with canned
 * forecast/alert text. Unknown methods get JSON-RPC error -32601.
 */
export async function main(): Promise<void> {
  throw new Error("not implemented");
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[weather-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
