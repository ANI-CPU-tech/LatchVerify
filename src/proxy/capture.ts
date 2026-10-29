import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { VERSION } from "../version.js";
import {
  MAX_LINE_BYTES,
  isRequest,
  isResponse,
  readFrames,
  serialize,
  spawnUpstream,
  writeLine,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./transport.js";

/** MCP revision requested in initialize. The server answers with the one it speaks. */
export const CAPTURE_PROTOCOL_VERSION = "2025-06-18";

/** Default for CaptureOptions.timeoutMs: generous, since `npx` may download the server first. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

/** Pages of tools/list followed before giving up on a server that never stops paging. */
export const MAX_CAPTURE_PAGES = 100;

/** How long a server gets to exit after its stdin closes, and again after SIGTERM. */
const EXIT_GRACE_MS = 2_000;

export interface CaptureOptions {
  /** Whole-capture deadline, from spawn to the last tools/list page. */
  timeoutMs?: number;
  /** Extra environment for the server, merged over process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CapturedTools {
  /** Every entry of every tools/list page, unvalidated: analysis decides what is valid. */
  tools: unknown[];
  /** Protocol version the server answered initialize with, or null if it named none. */
  specVersion: string | null;
}

/** Why a server's tools could not be captured. The message is safe to show as is. */
export class CaptureError extends Error {
  override readonly name = "CaptureError";
}

/**
 * Start an MCP server over stdio, act as a minimal client (initialize, notifications/initialized,
 * then tools/list following nextCursor) and return every tool it lists. The server is then shut
 * down: stdin closed, SIGTERM after a grace period, SIGKILL after another (after a failure,
 * SIGTERM straight away). Its stderr passes through to ours.
 *
 * Server requests are answered (ping with an empty result, anything else with -32601) so a
 * server that asks the client something cannot stall the capture; notifications are ignored.
 * Lines on stdout that are not JSON-RPC (a startup banner, a stray console.log) are skipped, as
 * the proxy forwards them without acting on them; the first one is reported on stderr.
 *
 * @throws CaptureError when the server cannot be started, exits early, writes a line longer than
 * MAX_LINE_BYTES, answers with an error or a result without a tools array, pages more than
 * MAX_CAPTURE_PAGES times, or misses the deadline.
 */
export async function captureTools(command: string, args: readonly string[], options: CaptureOptions = {}): Promise<CapturedTools> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const child = spawnUpstream(command, [...args], options.env);
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const waiting = new Map<JsonRpcId, { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let failure: CaptureError | undefined;
  let reportedNoise = false;

  const fail = (error: CaptureError) => {
    failure ??= error;
    for (const request of waiting.values()) request.reject(failure);
    waiting.clear();
  };
  const send = (message: JsonRpcMessage) => {
    // A write failure means the server is gone; its close event reports that.
    writeLine(child.stdin, serialize(message)).catch(() => {});
  };

  child.on("error", (error) => fail(new CaptureError(`could not start ${command}: ${error.message}`)));
  child.once("close", (code, signal) =>
    fail(new CaptureError(`${command} exited (${signal ?? `code ${code}`}) before listing its tools`)),
  );
  child.stdin.on("error", () => {});
  const stopReading = readFrames(child.stdout, (frame) => {
    const { message } = frame;
    if (message === null) {
      if (!reportedNoise && frame.raw.trim() !== "") {
        reportedNoise = true;
        process.stderr.write(`[latch] ${command} wrote a line that is not JSON-RPC to stdout; skipping it and any more: ${preview(frame.raw)}\n`);
      }
      return;
    }
    if (isResponse(message)) {
      const request = waiting.get(message.id);
      if (request === undefined) return;
      waiting.delete(message.id);
      if (message.error !== undefined) {
        request.reject(new CaptureError(`${command} answered ${request.method} with error ${message.error.code}: ${message.error.message}`));
      } else {
        request.resolve(message.result);
      }
    } else if (isRequest(message)) {
      send(
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } },
      );
    }
  }, { onOverflow: () => fail(new CaptureError(`${command} wrote a line longer than ${MAX_LINE_BYTES} bytes`)) });

  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      const id = nextId++;
      waiting.set(id, { method, resolve, reject });
      send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    });

  const deadline = setTimeout(() => fail(new CaptureError(`${command} did not list its tools within ${timeoutMs} ms`)), timeoutMs);
  let succeeded = false;
  try {
    const init = await request("initialize", {
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "latchverify", version: VERSION },
    });
    const specVersion = isPlainObject(init) && typeof init.protocolVersion === "string" && init.protocolVersion !== "" ? init.protocolVersion : null;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      const result = await request("tools/list", cursor === undefined ? undefined : { cursor });
      if (!isPlainObject(result) || !Array.isArray(result.tools)) {
        throw new CaptureError(`${command} answered tools/list without a tools array`);
      }
      tools.push(...result.tools);
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") {
        succeeded = true;
        return { tools, specVersion };
      }
      if (page >= MAX_CAPTURE_PAGES) throw new CaptureError(`${command} kept paging tools/list past ${MAX_CAPTURE_PAGES} pages`);
      cursor = result.nextCursor;
    }
  } finally {
    clearTimeout(deadline);
    stopReading();
    await shutdown(child, exited, succeeded);
  }
}

/**
 * Close stdin and escalate to SIGTERM, then SIGKILL, until the server has exited. A server that
 * failed is sent SIGTERM at once instead of being given time to exit on its own.
 */
async function shutdown(child: ChildProcessWithoutNullStreams, exited: Promise<void>, graceful: boolean): Promise<void> {
  child.stdin.end();
  if (graceful && (await settlesWithin(exited, EXIT_GRACE_MS))) return;
  child.kill("SIGTERM");
  if (await settlesWithin(exited, EXIT_GRACE_MS)) return;
  child.kill("SIGKILL");
  await settlesWithin(exited, EXIT_GRACE_MS);
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first 80 characters of a line, JSON-quoted so control characters cannot reach a terminal. */
function preview(line: string): string {
  const chars = [...line];
  return JSON.stringify(chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : line);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
