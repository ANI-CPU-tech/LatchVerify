import { isAutoPass } from "../analyze/tiers.js";
import type { LockFile, PendingChange } from "../schema/index.js";
import { appendEvent, type LatchEvent } from "../store/events.js";
import { enqueue, writePending } from "../store/pending.js";
import { analyzeToolList, type ListAnalysis } from "./analysis.js";
import {
  isRequest,
  isResponse,
  type Direction,
  type Frame,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./transport.js";

/** What the proxy does with one frame. */
export type InterceptDecision =
  /** Pass the original raw line through unchanged. */
  | { action: "forward" }
  /** Pass a modified message onward in the same direction. */
  | { action: "rewrite"; message: JsonRpcMessage }
  /** Swallow the frame and reply to its sender instead (used to block tools/call). */
  | { action: "respond"; message: JsonRpcResponse }
  /** Swallow the frame: a response to a request the proxy sent itself. */
  | { action: "drop" };

/** Mutable per-connection state shared by the handlers below. */
export interface InterceptorContext {
  serverId: string;
  lockfile: LockFile;
  /** The pending queue as last read from or written to <stateDir>/pending.json. */
  pending: PendingChange[];
  /** Client request ids awaiting a server response, mapped to their method. */
  inflight: Map<JsonRpcId, string>;
  /** MCP protocol revision negotiated in `initialize`. */
  specVersion: string | null;
  /** Directory holding pending.json and events.jsonl. */
  stateDir: string;
  /**
   * Latest analysis of each of this server's tools that differs from latch.lock. Kept for the
   * session even after `latch review` drops the change from the queue, so a rejected definition
   * the server still serves stays blocked.
   */
  observed: Map<string, PendingChange>;
  /** True once a tools/list result has been analyzed since start or the last list_changed. */
  verified: boolean;
  /** Ids of tools/list requests the proxy sent itself, mapped to their page number. */
  ownRequests: Map<JsonRpcId, number>;
  /** Queue a request to the server. It is written after the frame being routed is handled. */
  sendToServer(message: JsonRpcRequest): void;
  /** Re-read latch.lock and the pending queue if they changed on disk (approvals, rejections). */
  refresh(): Promise<void>;
  /** Write one diagnostic line to stderr. stdout is the protocol. */
  log(message: string): void;
}

const FORWARD: InterceptDecision = Object.freeze({ action: "forward" });

/** Client requests whose responses the proxy inspects. */
const TRACKED_METHODS: ReadonlySet<string> = new Set(["initialize", "tools/list"]);

/**
 * Entry point for every frame.
 *
 * Client to server: initialize and tools/list request ids are recorded in ctx.inflight (only
 * those, so requests the server never answers cannot grow the map without bound).
 *
 * Server to client: the initialize response sets specVersion; a tools/list response matched via
 * ctx.inflight goes to onToolsList.
 *
 * Everything else, and every unparseable frame, is "forward".
 */
export async function routeFrame(ctx: InterceptorContext, direction: Direction, frame: Frame): Promise<InterceptDecision> {
  const { message } = frame;
  if (message === null) return FORWARD;

  if (direction === "client->server") {
    if (isRequest(message) && TRACKED_METHODS.has(message.method)) ctx.inflight.set(message.id, message.method);
    return FORWARD;
  }

  if (isResponse(message)) {
    const method = ctx.inflight.get(message.id);
    if (method === undefined) return FORWARD;
    ctx.inflight.delete(message.id);
    if (method === "initialize") captureSpecVersion(ctx, message);
    if (method === "tools/list") return onToolsList(ctx, message);
  }
  return FORWARD;
}

/**
 * tools/list response from the server.
 *
 * Runs analyzeToolList over the result and records the outcome: every new or changed tool is
 * queued (tier 0 and 1 too, so `latch review` can fold them into the lockfile; the blocker lets
 * them through), logged as change_detected, and tier 0/1 also as auto_passed. A definition
 * already queued or already seen this session is not queued again, so repeated lists do not
 * churn change ids. A tool back at its pinned definition leaves ctx.observed, but its queued
 * change stays for review: the server did serve that definition.
 *
 * Returns "forward": the client still sees the list; enforcement happens at tools/call.
 */
export async function onToolsList(ctx: InterceptorContext, response: JsonRpcResponse): Promise<InterceptDecision> {
  if (response.error !== undefined) return FORWARD;
  await ctx.refresh();
  const now = new Date();
  const analysis = analyzeToolList(ctx.serverId, response.result, ctx.lockfile, ctx.specVersion, now);
  if (analysis === null) {
    ctx.log(`${ctx.serverId}: tools/list result has no tools array; nothing analyzed`);
    return FORWARD;
  }
  await recordAnalysis(ctx, analysis, now);
  return FORWARD;
}

async function recordAnalysis(ctx: InterceptorContext, analysis: ListAnalysis, now: Date): Promise<void> {
  const at = now.toISOString();
  const { serverId } = ctx;
  const events: LatchEvent[] = [{ kind: "tools_listed", at, serverId, toolCount: analysis.toolCount }];
  for (const name of analysis.unchanged) ctx.observed.delete(name);

  let queueChanged = false;
  for (const { change, reason } of analysis.changes) {
    const { toolName, tier } = change;
    const composite = change.after.hashes.composite;
    if (ctx.observed.get(toolName)?.after.hashes.composite === composite) continue;
    const queued = ctx.pending.find(
      (entry) => entry.serverId === serverId && entry.toolName === toolName && entry.after.hashes.composite === composite,
    );
    ctx.observed.set(toolName, queued ?? change);
    if (queued !== undefined) continue;

    ctx.pending = enqueue(ctx.pending, change);
    queueChanged = true;
    events.push({ kind: "change_detected", at, serverId, toolName, tier, changeId: change.id });
    if (isAutoPass(tier)) {
      events.push({ kind: "auto_passed", at, serverId, toolName, tier });
      ctx.log(`${serverId}/${toolName}: tier ${tier} change auto-passed: ${reason}`);
    } else {
      ctx.log(`${serverId}/${toolName}: tier ${tier} change ${tier === 3 ? "hard-blocked" : "blocked for review"}: ${reason}`);
    }
  }
  ctx.verified = true;

  if (queueChanged) await persist(ctx, "pending queue", () => writePending(ctx.stateDir, ctx.pending));
  for (const event of events) await persist(ctx, "event log", () => appendEvent(ctx.stateDir, event));
}

/**
 * tools/call request from the client.
 * TODO: run shouldBlock(); when blocked return "respond" with buildBlockError(), else "forward".
 */
export async function onToolsCall(ctx: InterceptorContext, request: JsonRpcRequest): Promise<InterceptDecision> {
  throw new Error("not implemented");
}

/**
 * notifications/tools/list_changed from the server: the rug-pull signal.
 * TODO: log a list_changed event, issue our own tools/list to the server so the new
 * definitions are analyzed before the client re-fetches, then "forward" the notification.
 */
export async function onToolsListChanged(ctx: InterceptorContext, notification: JsonRpcNotification): Promise<InterceptDecision> {
  throw new Error("not implemented");
}

function captureSpecVersion(ctx: InterceptorContext, response: JsonRpcResponse): void {
  const result = response.result;
  if (isPlainObject(result) && typeof result.protocolVersion === "string" && result.protocolVersion !== "") {
    ctx.specVersion = result.protocolVersion;
  }
}

/**
 * Run a state write, logging instead of throwing on failure. Enforcement never depends on it:
 * the in-memory queue and ctx.observed keep blocking whatever the disk holds.
 */
async function persist(ctx: InterceptorContext, what: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    ctx.log(`could not write the ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
