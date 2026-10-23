import { randomUUID } from "node:crypto";
import { isAutoPass } from "../analyze/tiers.js";
import type { LockFile, PendingChange } from "../schema/index.js";
import { appendEvent, type LatchEvent } from "../store/events.js";
import { enqueue, writePending } from "../store/pending.js";
import { analyzeToolList, type ListAnalysis } from "./analysis.js";
import { buildBlockError, shouldBlock, type BlockReason, type BlockVerdict } from "./blocker.js";
import {
  isNotification,
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
const DROP: InterceptDecision = Object.freeze({ action: "drop" });

/** Client requests whose responses the proxy inspects. */
const TRACKED_METHODS: ReadonlySet<string> = new Set(["initialize", "tools/list"]);

/**
 * Entry point for every frame.
 *
 * Client to server: tools/call goes to onToolsCall. initialize and tools/list request ids are
 * recorded in ctx.inflight (only those, so requests the server never answers cannot grow the
 * map without bound). A JSON-RPC batch is refused: tools/call inside an array would slip past
 * enforcement, and MCP 2025-06-18 removed batching. notifications/initialized is forwarded and
 * followed by the proxy's own tools/list, so the server's tools are verified before the client
 * calls one, even when the client relies on a list it fetched in an earlier session.
 *
 * Server to client: a response to the proxy's own tools/list is analyzed and dropped, since the
 * client never asked for it. The initialize response sets specVersion; a tools/list response
 * matched via ctx.inflight goes to onToolsList; notifications/tools/list_changed goes to
 * onToolsListChanged.
 *
 * Everything else, and every unparseable frame, is "forward".
 */
export async function routeFrame(ctx: InterceptorContext, direction: Direction, frame: Frame): Promise<InterceptDecision> {
  const { message } = frame;
  if (message === null) {
    if (direction === "client->server" && isBatch(frame.raw)) {
      ctx.log("refused a JSON-RPC batch from the client");
      return respond(null, INVALID_REQUEST, "LatchVerify does not forward JSON-RPC batches; send one message per line");
    }
    return FORWARD;
  }

  if (direction === "client->server") {
    if (isNotification(message) && message.method === "notifications/initialized") {
      requestToolList(ctx);
      return FORWARD;
    }
    if (!isRequest(message)) return FORWARD;
    if (message.method === "tools/call") return onToolsCall(ctx, message);
    if (TRACKED_METHODS.has(message.method)) ctx.inflight.set(message.id, message.method);
    return FORWARD;
  }

  if (isResponse(message)) {
    const page = ctx.ownRequests.get(message.id);
    if (page !== undefined) {
      ctx.ownRequests.delete(message.id);
      await onOwnToolList(ctx, message, page);
      return DROP;
    }
    const method = ctx.inflight.get(message.id);
    if (method === undefined) return FORWARD;
    ctx.inflight.delete(message.id);
    if (method === "initialize") captureSpecVersion(ctx, message);
    if (method === "tools/list") return onToolsList(ctx, message);
    return FORWARD;
  }
  if (isNotification(message) && message.method === "notifications/tools/list_changed") {
    return onToolsListChanged(ctx, message);
  }
  return FORWARD;
}

/** Pages the proxy fetches on its own before giving up on a server that never stops paging. */
export const MAX_OWN_PAGES = 100;

/** Send the proxy's own tools/list (page `page`, from `cursor`) to the server. */
function requestToolList(ctx: InterceptorContext, cursor?: string, page = 1): void {
  const id = `latchverify-${randomUUID()}`;
  ctx.ownRequests.set(id, page);
  ctx.sendToServer(
    cursor === undefined ? { jsonrpc: "2.0", id, method: "tools/list" } : { jsonrpc: "2.0", id, method: "tools/list", params: { cursor } },
  );
}

/** Analyze a page of the proxy's own tools/list and fetch the next one, if any. */
async function onOwnToolList(ctx: InterceptorContext, response: JsonRpcResponse, page: number): Promise<void> {
  if (response.error !== undefined) {
    ctx.log(`${ctx.serverId}: the server answered the proxy's tools/list with an error: ${response.error.message}`);
    return;
  }
  await onToolsList(ctx, response);
  const cursor = isPlainObject(response.result) ? response.result.nextCursor : undefined;
  if (typeof cursor !== "string") return;
  if (page >= MAX_OWN_PAGES) {
    ctx.log(`${ctx.serverId}: stopped fetching tools/list after ${MAX_OWN_PAGES} pages`);
    return;
  }
  requestToolList(ctx, cursor, page + 1);
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
 * tools/call request from the client: "respond" with buildBlockError() when blocked, else
 * "forward". A blocked call never reaches the server.
 *
 * Blocked when no tools/list has been analyzed since start or the last list_changed
 * ("unverified": the server may be serving definitions nobody has checked), or when
 * shouldBlock() objects given the queue and this session's observed changes. The observed
 * changes keep a definition blocked after `latch review` rejects it, and after a failed state
 * write. Every block is logged and recorded as a call_blocked event.
 *
 * A call without a string tool name cannot be checked, so it is answered with -32602 instead
 * of forwarded.
 */
export async function onToolsCall(ctx: InterceptorContext, request: JsonRpcRequest): Promise<InterceptDecision> {
  const params = request.params;
  if (!isPlainObject(params) || typeof params.name !== "string") {
    ctx.log("refused a tools/call without a string tool name");
    return respond(request.id, INVALID_PARAMS, "Invalid params: tools/call needs a string tool name");
  }
  const toolName = params.name;
  await ctx.refresh();
  const verdict: BlockVerdict = ctx.verified
    ? shouldBlock(ctx.serverId, toolName, ctx.lockfile, [...ctx.pending, ...ctx.observed.values()])
    : { blocked: true, reason: { kind: "unverified" } };
  if (!verdict.blocked) return FORWARD;

  const reason = describeReason(verdict.reason);
  ctx.log(`blocked ${ctx.serverId}/${toolName}: ${reason}`);
  await persist(ctx, "event log", () =>
    appendEvent(ctx.stateDir, { kind: "call_blocked", at: new Date().toISOString(), serverId: ctx.serverId, toolName, reason }),
  );
  return { action: "respond", message: buildBlockError(request.id, toolName, verdict.reason) };
}

/** "hard_block chg_7f3a91", "unpinned": the event log's reason text. */
function describeReason(reason: BlockReason): string {
  return "changeId" in reason ? `${reason.kind} ${reason.changeId}` : reason.kind;
}

/**
 * notifications/tools/list_changed from the server: the rug-pull signal.
 *
 * Marks the server unverified, so calls are blocked until the new definitions are analyzed, logs
 * a list_changed event, and sends the proxy's own tools/list so the analysis does not wait for
 * the client to re-fetch. Then "forward": the client still learns the list changed.
 */
export async function onToolsListChanged(ctx: InterceptorContext, _notification: JsonRpcNotification): Promise<InterceptDecision> {
  ctx.verified = false;
  ctx.log(`${ctx.serverId}: server announced tools/list_changed; re-checking its tools`);
  requestToolList(ctx);
  await persist(ctx, "event log", () =>
    appendEvent(ctx.stateDir, { kind: "list_changed", at: new Date().toISOString(), serverId: ctx.serverId }),
  );
  return FORWARD;
}

const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;

function respond(id: JsonRpcId, code: number, message: string): InterceptDecision {
  return { action: "respond", message: { jsonrpc: "2.0", id, error: { code, message } } };
}

/** True when the line is a JSON array: a batch, or an empty or malformed one. */
function isBatch(raw: string): boolean {
  if (!raw.trimStart().startsWith("[")) return false;
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
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
