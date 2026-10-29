import { stat } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { LlmOptions } from "../analyze/llm.js";
import type { LogLevel } from "../config/env.js";
import { createLogger } from "../log.js";
import type { LockFile } from "../schema/index.js";
import { appendEvent } from "../store/events.js";
import { LockIntegrity } from "../store/integrity.js";
import { emptyLockfile, parseLockfile, pinFirstRun, readLockfileText, writeLockfile } from "../store/lockfile.js";
import { PENDING_FILE, readPending, withStateLock } from "../store/pending.js";
import { defaultReviewer } from "../config/reviewer.js";
import { REJECTED_FILE, readRejected } from "../store/rejected.js";
import { buildBlockError } from "./blocker.js";
import { routeFrame, type InterceptDecision, type InterceptorContext } from "./interceptor.js";
import {
  MAX_LINE_BYTES,
  isRequest,
  readFrames,
  serialize,
  spawnUpstream,
  writeLine,
  type Direction,
  type Frame,
  type JsonRpcMessage,
} from "./transport.js";

export interface ProxyOptions {
  /** Key of this server in latch.lock. */
  serverId: string;
  /** Real server executable and arguments. */
  command: string;
  args: string[];
  lockfilePath: string;
  stateDir: string;
  /** The MCP client's side of the connection. Defaults to process.stdin and process.stdout. */
  input?: Readable;
  output?: Writable;
  /** How long client frames are held waiting for the server's tools to be verified. */
  holdTimeoutMs?: number;
  /** Run the LLM advisory pass on new and changed tools with these options. Off when absent. */
  llm?: LlmOptions;
  /** Longest line accepted from either side. Defaults to MAX_LINE_BYTES. */
  maxLineBytes?: number;
  /** How long the server gets to exit before the next, harder signal. Defaults to EXIT_GRACE_MS. */
  exitGraceMs?: number;
  /** Least severe diagnostics written to stderr (LATCH_LOG_LEVEL). Defaults to info. */
  logLevel?: LogLevel;
}

/** Default for ProxyOptions.holdTimeoutMs. */
export const DEFAULT_HOLD_TIMEOUT_MS = 10_000;

/** Default for ProxyOptions.exitGraceMs. */
export const EXIT_GRACE_MS = 5_000;

/** Signals passed on to the real server. The proxy itself exits when the server does. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Run the stdio proxy until the real server exits. Resolves with its exit code (128 + the signal
 * number when a signal ended it).
 *
 * Loads latch.lock, the pending queue and the rejections (a malformed file rejects: the proxy
 * fails closed rather than run without its state), spawns the server, and routes every line from both sides
 * through routeFrame(), then applies the decision: forward the raw line, write a rewritten
 * message, reply to the sender, or drop. Messages the interceptor sends on its own follow the
 * frame that caused them.
 *
 * Frames from both directions go through one queue in arrival order, so a tools/call that
 * arrives after a tools/list response is always checked against that list's analysis. Writes
 * keep their order per side and do not hold up routing.
 *
 * A tools/call that arrives while the server's tools are unverified (before the first tools/list
 * is analyzed, or after list_changed) is held, with every later tools/call, cancellation and the
 * end of the client's input, until a list has been analyzed. Clients that pipeline requests thus
 * get their calls checked against the right definitions instead of refused. Every other client
 * frame passes meanwhile, above all the client's answers to the server's own requests
 * (roots/list, sampling): holding those could stall a server that waits for them before it lists
 * its tools. Server frames keep flowing too. After `holdTimeoutMs` the held frames are routed
 * anyway, and calls still unverified are blocked.
 *
 * latch.lock, the queue and the rejections are re-read whenever they change on disk, so an
 * approval or rejection made with `latch review` applies to the next tools/call without
 * restarting the proxy. A latch.lock whose content LatchVerify did not write (LockIntegrity) is
 * not adopted: the proxy keeps the version it already trusts (at start, the copy LatchVerify last
 * wrote, or an empty lockfile, which blocks every call), and logs a lock_tampered event.
 *
 * When the client closes its input, the server's stdin is closed once everything queued for
 * it is written; when the client stops reading, or either side sends a line longer than
 * `maxLineBytes`, the server is sent SIGTERM. SIGINT, SIGTERM and SIGHUP are passed on to the
 * server. A server that has not exited `exitGraceMs` after its stdin closed is sent SIGTERM, and
 * one still running `exitGraceMs` after any signal is sent SIGKILL, so the proxy never waits on a
 * server forever. If the proxy's own process exits first, the server is killed with it. Only JSON-RPC is written to `output`; diagnostics go to
 * stderr and the event log.
 *
 * @throws Error when latch.lock or the queue is malformed, or the server cannot be started.
 */
export async function startProxy(options: ProxyOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const logger = createLogger(options.logLevel);
  const log = logger.info;

  const pendingPath = join(options.stateDir, PENDING_FILE);
  const integrity = new LockIntegrity(options.lockfilePath);
  // Once a record has vouched for latch.lock, a missing record later means it was removed.
  let recorded = false;
  /**
   * latch.lock as it is on disk, if LatchVerify wrote it (or a person accepted it); `fallback`
   * when the content is one the integrity record does not vouch for. Logged and recorded once
   * per change on disk.
   */
  const loadLockfile = async (fallback: () => Promise<LockFile>): Promise<LockFile> => {
    const text = await readLockfileText(options.lockfilePath);
    if (text === undefined) return emptyLockfile();
    const status = await integrity.check(text);
    if (status === "trusted" || (status === "unrecorded" && !recorded)) {
      const lock = parseLockfile(options.lockfilePath, text);
      if (status === "trusted") recorded = true;
      else logger.debug(`${options.lockfilePath} has no integrity record yet; LatchVerify records one on its next write`);
      return lock;
    }
    logger.warn(
      `${options.lockfilePath} was changed outside LatchVerify; keeping the last version it trusted. Run \`latch lock accept\` if the edit was yours, or \`latch lock restore\``,
    );
    await appendEvent(options.stateDir, {
      kind: "lock_tampered",
      at: new Date().toISOString(),
      serverId: options.serverId,
      path: options.lockfilePath,
    }).catch((error: unknown) => logger.error(`could not write the event log: ${error instanceof Error ? error.message : String(error)}`));
    return fallback();
  };

  // Stamp before reading: a change that lands in between is picked up by the next refresh.
  // The integrity record is part of the stamp: `latch lock accept` changes trust, not the file.
  const lockStampNow = async () => `${await fileStamp(options.lockfilePath)}|${await fileStamp(integrity.recordPath)}`;
  let lockStamp = await lockStampNow();
  const lockfile = await loadLockfile(async () => {
    // Nothing trusted in memory yet: the copy LatchVerify last wrote, or nothing pinned at all.
    const good = await integrity.lastGood();
    return good === undefined ? emptyLockfile() : parseLockfile(options.lockfilePath, good);
  });
  let pendingStamp = await fileStamp(pendingPath);
  const pending = await readPending(options.stateDir);
  const rejectedPath = join(options.stateDir, REJECTED_FILE);
  let rejectedStamp = await fileStamp(rejectedPath);
  const rejected = await readRejected(options.stateDir);
  if (!Object.hasOwn(lockfile.servers, options.serverId)) {
    log(`server "${options.serverId}" is not in ${options.lockfilePath}; its tool calls stay blocked until it is pinned`);
  }

  logger.debug(`starting ${options.serverId}: ${[options.command, ...options.args].join(" ")}`);
  const child = spawnUpstream(options.command, options.args);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`could not start ${options.command}: ${error.message}`, { cause: error })));
  });
  child.on("error", (error) => logger.error(`server process error: ${error.message}`));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("close", (code, signal) => resolve([code, signal])),
  );

  const exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
  let escalation: NodeJS.Timeout | undefined;
  let running = true;
  void exited.then(() => {
    running = false;
    clearTimeout(escalation);
  });
  /** Send `signal` now, and SIGKILL if the server is still running after the grace period. */
  const signalServer = (signal: NodeJS.Signals) => {
    if (!running) return;
    child.kill(signal);
    clearTimeout(escalation);
    escalation = setTimeout(() => {
      if (!running) return;
      logger.warn(`the server is still running ${exitGraceMs} ms after ${signal}; sending SIGKILL`);
      child.kill("SIGKILL");
    }, exitGraceMs);
  };
  const killWithProxy = () => {
    if (running) child.kill("SIGKILL");
  };
  process.once("exit", killWithProxy);

  const toServer = lineWriter(child.stdin, (error) => logger.error(`could not write to the server: ${error.message}`));
  const toClient = lineWriter(output, (error) => {
    logger.warn(`could not write to the client (${error.message}); stopping the server`);
    signalServer("SIGTERM");
  });

  const outbox: JsonRpcMessage[] = [];
  const ctx: InterceptorContext = {
    serverId: options.serverId,
    lockfile,
    pending,
    rejected,
    inflight: new Map(),
    specVersion: null,
    stateDir: options.stateDir,
    observed: new Map(),
    verified: false,
    ownRequests: new Map(),
    // Loaded only when the advisory pass is on, so a proxy without it never holds the LLM client.
    advise: options.llm === undefined ? undefined : async (tool, cached) => (await import("../analyze/llm.js")).runAdvisory(tool, options.llm!, cached),
    sendToServer: (message) => void outbox.push(message),
    pinFirstRun: (changes) =>
      withStateLock(options.stateDir, async () => {
        // Re-read under the lock, trusted only: a latch.lock edited outside LatchVerify must not
        // be able to mark a server for trust on first use and get its tools approved.
        const text = await readLockfileText(options.lockfilePath);
        if (text === undefined) return undefined;
        const status = await integrity.check(text);
        if (!(status === "trusted" || (status === "unrecorded" && !recorded))) return undefined;
        const current = parseLockfile(options.lockfilePath, text);
        // Another proxy of the same server (a second client) pinned it meanwhile: use its pins.
        if (current.servers[options.serverId]?.trustOnFirstUse !== true) return current;
        const outcome = pinFirstRun(current, options.serverId, changes, defaultReviewer(), new Date());
        await writeLockfile(options.lockfilePath, outcome.lock);
        lockStamp = await lockStampNow();
        log(
          `${options.serverId}: first run, so its tools were pinned (trust on first use): ${outcome.pinned.join(", ") || "none"}` +
            (outcome.held.length > 0 ? `; held for review: ${outcome.held.join(", ")}` : ""),
        );
        return outcome.lock;
      }).catch((error: unknown) => {
        logger.error(`could not pin ${options.serverId} on its first run: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }),
    refresh: async () => {
      const nextLock = await lockStampNow().catch(() => lockStamp);
      if (nextLock !== lockStamp) {
        // Advance the stamp even on failure: a bad file is reported once, not on every call.
        lockStamp = nextLock;
        try {
          const current = ctx.lockfile;
          ctx.lockfile = await loadLockfile(async () => current);
          logger.debug(`reloaded ${options.lockfilePath}`);
        } catch (error) {
          logger.warn(`kept the previous latch.lock: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const nextPending = await fileStamp(pendingPath).catch(() => pendingStamp);
      if (nextPending !== pendingStamp) {
        pendingStamp = nextPending;
        try {
          ctx.pending = await readPending(options.stateDir);
          logger.debug(`reloaded the pending queue (${ctx.pending.length} changes)`);
        } catch (error) {
          logger.warn(`kept the previous pending queue: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const nextRejected = await fileStamp(rejectedPath).catch(() => rejectedStamp);
      if (nextRejected !== rejectedStamp) {
        rejectedStamp = nextRejected;
        try {
          ctx.rejected = await readRejected(options.stateDir);
          logger.debug(`reloaded the rejections (${ctx.rejected.length})`);
        } catch (error) {
          logger.warn(`kept the previous rejections: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    log,
  };

  const handle = async (direction: Direction, frame: Frame | typeof END): Promise<void> => {
    if (frame === END) {
      await toServer.flushed();
      child.stdin.end();
      clearTimeout(escalation);
      escalation = setTimeout(() => {
        if (!running) return;
        logger.warn(`the server is still running ${exitGraceMs} ms after its input closed; sending SIGTERM`);
        signalServer("SIGTERM");
      }, exitGraceMs);
      return;
    }
    let decision: InterceptDecision;
    try {
      decision = await routeFrame(ctx, direction, frame);
    } catch (error) {
      logger.error(`internal error while routing a frame: ${error instanceof Error ? error.message : String(error)}`);
      decision = failClosed(ctx, direction, frame);
    }
    if (decision.action !== "forward") logger.debug(`${direction} ${describeFrame(frame)}: ${decision.action}`);
    const [onward, back] = direction === "client->server" ? [toServer, toClient] : [toClient, toServer];
    if (decision.action === "forward") onward.write(frame.raw);
    else if (decision.action === "rewrite") onward.write(serialize(decision.message));
    else if (decision.action === "respond") back.write(serialize(decision.message));
    for (const message of outbox.splice(0)) toServer.write(serialize(message));
  };

  // Client frames held while the server's tools are unverified; null when nothing is held.
  let held: Array<Frame | typeof END> | null = null;
  let holdTimer: NodeJS.Timeout | undefined;
  const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;

  const fromClient = async (frame: Frame | typeof END): Promise<void> => {
    if (held !== null && (frame === END || keepsOrderWithCalls(frame))) {
      held.push(frame);
    } else if (frame !== END && !ctx.verified && isToolsCall(frame)) {
      logger.debug(`holding ${describeFrame(frame)} until the server's tools are verified`);
      held = [frame];
      holdTimer = setTimeout(() => enqueue(() => release(true)), holdTimeoutMs);
    } else {
      await handle("client->server", frame);
    }
  };

  /** Route held frames in order; a timeout routes them even if still unverified. */
  const release = async (timedOut: boolean): Promise<void> => {
    if (held === null || (!timedOut && !ctx.verified)) return;
    clearTimeout(holdTimer);
    const frames = held;
    held = null;
    if (timedOut) logger.warn(`tools still unverified after ${holdTimeoutMs} ms; releasing ${frames.length} held client frames`);
    for (const [i, frame] of frames.entries()) {
      if (timedOut) {
        await handle("client->server", frame);
        continue;
      }
      await fromClient(frame);
      // fromClient holds again if a call meets an unverified server; keep the rest behind it.
      const again = held as Array<Frame | typeof END> | null;
      if (again !== null) {
        again.push(...frames.slice(i + 1));
        return;
      }
    }
  };

  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => logger.error(`internal error: ${String(error)}`));
  };
  const { maxLineBytes } = options;
  const stopClient = readFrames(input, (frame) => enqueue(() => fromClient(frame)), {
    maxLineBytes,
    onOverflow: () => {
      logger.warn(`the client sent a line longer than ${maxLineBytes ?? MAX_LINE_BYTES} bytes; stopping the server`);
      signalServer("SIGTERM");
    },
  });
  const stopServer = readFrames(
    child.stdout,
    (frame) =>
      enqueue(async () => {
        await handle("server->client", frame);
        await release(false);
      }),
    {
      maxLineBytes,
      onOverflow: () => {
        logger.warn(`the server wrote a line longer than ${maxLineBytes ?? MAX_LINE_BYTES} bytes; stopping it`);
        signalServer("SIGTERM");
      },
    },
  );
  // Registered after readFrames, so readline has delivered a final unterminated line by now.
  input.once("end", () => enqueue(() => fromClient(END)));

  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      log(`received ${signal}; passing it on to the server`);
      signalServer(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  try {
    const [code, signal] = await exited;
    await queue;
    await toClient.flushed();
    return code ?? (signal !== null ? 128 + (constants.signals[signal] ?? 0) : 1);
  } finally {
    clearTimeout(holdTimer);
    clearTimeout(escalation);
    process.off("exit", killWithProxy);
    stopClient();
    stopServer();
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

/**
 * Identity of a file's current content: inode, size and mtime ("missing" when absent). Atomic
 * writes rename a new file into place, so every write changes the inode.
 */
async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** "tools/call #3", "response #3", "unparsed line": a frame named for logs, without its contents. */
function describeFrame(frame: Frame): string {
  const { message } = frame;
  if (message === null) return "unparsed line";
  const id = "id" in message ? ` #${JSON.stringify(message.id)}` : "";
  return `${typeof message.method === "string" ? message.method : "response"}${id}`;
}

/** Marks the end of the client's input in the client frame sequence. */
const END = Symbol("end of client input");

function isToolsCall(frame: Frame): boolean {
  return frame.message !== null && isRequest(frame.message) && frame.message.method === "tools/call";
}

/**
 * Client frames that must stay behind a held tools/call: later calls, and cancellations, which may
 * name a held call and would mean nothing to the server before it.
 */
function keepsOrderWithCalls(frame: Frame): boolean {
  return isToolsCall(frame) || (frame.message !== null && frame.message.method === "notifications/cancelled");
}

/**
 * The decision when routing itself failed. A tools/call from the client is answered with an
 * error rather than forwarded unchecked, and the server is marked unverified so later calls are
 * blocked until a tool list is analyzed again. Anything else is forwarded.
 */
function failClosed(ctx: InterceptorContext, direction: Direction, frame: Frame): InterceptDecision {
  ctx.verified = false;
  const { message } = frame;
  if (direction === "client->server" && message !== null && isRequest(message) && message.method === "tools/call") {
    const name = (message.params as { name?: unknown } | null | undefined)?.name;
    return { action: "respond", message: buildBlockError(message.id, typeof name === "string" ? name : "(unnamed)", { kind: "internal_error" }) };
  }
  return { action: "forward" };
}

/** Ordered, non-blocking line writes to one stream. The first failure is reported once. */
function lineWriter(stream: Writable, onError: (error: Error) => void) {
  let chain = Promise.resolve();
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  stream.on("error", fail);
  return {
    write(line: string): void {
      if (failed) return;
      chain = chain.then(() => writeLine(stream, line)).catch(fail);
    },
    flushed: (): Promise<void> => chain,
  };
}

export * from "./transport.js";
export * from "./interceptor.js";
export * from "./blocker.js";
export * from "./analysis.js";
export * from "./capture.js";
