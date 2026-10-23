import { randomUUID } from "node:crypto";
import { isAutoPass } from "../analyze/tiers.js";
import type { LlmAdvisory, LockFile, McpTool, PendingChange } from "../schema/index.js";
import { appendEvent, type LatchEvent } from "../store/events.js";
import { enqueue, updatePending } from "../store/pending.js";
import { analyzeToolList, type DetectedChange, type ListAnalysis } from "./analysis.js";
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
  /** True once a complete tools/list has been analyzed since start or the last list_changed. */
  verified: boolean;
  /** Ids of tools/list requests the proxy sent itself, mapped to the listing they continue. */
  ownRequests: Map<JsonRpcId, OwnListing>;
  /**
   * The optional LLM advisory pass (runAdvisory with the configured options); undefined when
   * LATCH_LLM_ENABLED is off. `cached` is the pinned record's advisory.
   */
  advise?: (tool: McpTool, cached: LlmAdvisory | undefined) => Promise<LlmAdvisory>;
  /** Queue a request to the server. It is written after the frame being routed is handled. */
  sendToServer(message: JsonRpcRequest): void;
  /** Re-read latch.lock and the pending queue if they changed on disk (approvals, rejections). */
  refresh(): Promise<void>;
  /** Write one diagnostic line to stderr. stdout is the protocol. */
  log(message: string): void;
}

/** A tools/list the proxy is paging through itself. */
export interface OwnListing {
  /** Page number of the request this entry belongs to, from 1. */
  page: number;
  /** Tools from the pages before it. */
  tools: unknown[];
  /** Set by list_changed: the listing may mix old and new definitions, so it is dropped unanalyzed. */
  stale: boolean;
}

/** inflight value for a client tools/list that continues from a cursor: only a part of a list. */
const TOOLS_LIST_PAGE = "tools/list (page)";

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
    if (TRACKED_METHODS.has(message.method)) {
      const continues = message.method === "tools/list" && isPlainObject(message.params) && message.params.cursor !== undefined;
      ctx.inflight.set(message.id, continues ? TOOLS_LIST_PAGE : message.method);
    }
    return FORWARD;
  }

  if (isResponse(message)) {
    const listing = ctx.ownRequests.get(message.id);
    if (listing !== undefined) {
      ctx.ownRequests.delete(message.id);
      await onOwnToolList(ctx, message, listing);
      return DROP;
    }
    const method = ctx.inflight.get(message.id);
    if (method === undefined) return FORWARD;
    ctx.inflight.delete(message.id);
    if (method === "initialize") captureSpecVersion(ctx, message);
    if (method === "tools/list") return onToolsList(ctx, message);
    if (method === TOOLS_LIST_PAGE) return onToolsList(ctx, message, false);
    return FORWARD;
  }
  if (isNotification(message) && message.method === "notifications/tools/list_changed") {
    return onToolsListChanged(ctx, message);
  }
  return FORWARD;
}

/** Pages the proxy fetches on its own before giving up on a server that never stops paging. */
export const MAX_OWN_PAGES = 100;

/** Send the proxy's own tools/list (page `page`, from `cursor`, after `tools`) to the server. */
function requestToolList(ctx: InterceptorContext, cursor?: string, page = 1, tools: unknown[] = []): void {
  const id = `latchverify-${randomUUID()}`;
  ctx.ownRequests.set(id, { page, tools, stale: false });
  ctx.sendToServer(
    cursor === undefined ? { jsonrpc: "2.0", id, method: "tools/list" } : { jsonrpc: "2.0", id, method: "tools/list", params: { cursor } },
  );
}

/**
 * Collect a page of the proxy's own tools/list and fetch the next one. The last page analyzes the
 * whole list at once, so the server stays unverified (and calls held) until every page is in: a
 * drifted tool on page 2 must not become callable once page 1 checks out.
 */
async function onOwnToolList(ctx: InterceptorContext, response: JsonRpcResponse, listing: OwnListing): Promise<void> {
  if (listing.stale) return;
  if (response.error !== undefined) {
    ctx.log(`${ctx.serverId}: the server answered the proxy's tools/list with an error: ${response.error.message}`);
    return;
  }
  const { result } = response;
  if (!isPlainObject(result) || !Array.isArray(result.tools)) {
    ctx.log(`${ctx.serverId}: tools/list result has no tools array; nothing analyzed`);
    return;
  }
  const tools = [...listing.tools, ...result.tools];
  if (typeof result.nextCursor === "string" && result.nextCursor !== "") {
    if (listing.page >= MAX_OWN_PAGES) {
      ctx.log(`${ctx.serverId}: stopped fetching tools/list after ${MAX_OWN_PAGES} pages`);
      return;
    }
    requestToolList(ctx, result.nextCursor, listing.page + 1, tools);
    return;
  }
  await onToolsList(ctx, { ...response, result: { tools } });
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
 * Only a complete list marks the server verified: one that neither continues from a cursor
 * (`fromStart` false) nor has a nextCursor. A page of a list is still analyzed and queued, but
 * calls stay unverified until the proxy's own listing has seen every page.
 *
 * Returns "forward": the client still sees the list; enforcement happens at tools/call.
 */
export async function onToolsList(ctx: InterceptorContext, response: JsonRpcResponse, fromStart = true): Promise<InterceptDecision> {
  if (response.error !== undefined) return FORWARD;
  await ctx.refresh();
  const now = new Date();
  const analysis = analyzeToolList(ctx.serverId, response.result, ctx.lockfile, ctx.specVersion, now);
  if (analysis === null) {
    ctx.log(`${ctx.serverId}: tools/list result has no tools array; nothing analyzed`);
    return FORWARD;
  }
  const result = response.result as Record<string, unknown>;
  const complete = fromStart && (typeof result.nextCursor !== "string" || result.nextCursor === "");
  await recordAnalysis(ctx, analysis, now, complete);
  return FORWARD;
}

async function recordAnalysis(ctx: InterceptorContext, analysis: ListAnalysis, now: Date, complete: boolean): Promise<void> {
  const at = now.toISOString();
  const { serverId } = ctx;
  const events: LatchEvent[] = [{ kind: "tools_listed", at, serverId, toolCount: analysis.toolCount }];
  for (const name of analysis.unchanged) ctx.observed.delete(name);

  const added: DetectedChange[] = [];
  for (const detected of analysis.changes) {
    const { change, reason } = detected;
    const { toolName, tier } = change;
    const composite = change.after.hashes.composite;
    if (ctx.observed.get(toolName)?.after.hashes.composite === composite) continue;
    const queued = ctx.pending.find(
      (entry) => entry.serverId === serverId && entry.toolName === toolName && entry.after.hashes.composite === composite,
    );
    ctx.observed.set(toolName, queued ?? change);
    if (queued !== undefined) continue;

    ctx.pending = enqueue(ctx.pending, change);
    added.push(detected);
    events.push({ kind: "change_detected", at, serverId, toolName, tier, changeId: change.id });
    if (isAutoPass(tier)) {
      events.push({ kind: "auto_passed", at, serverId, toolName, tier });
      ctx.log(`${serverId}/${toolName}: tier ${tier} change auto-passed: ${reason}`);
    } else {
      ctx.log(`${serverId}/${toolName}: tier ${tier} change ${tier === 3 ? "hard-blocked" : "blocked for review"}: ${reason}`);
    }
  }
  if (complete) ctx.verified = true;

  if (added.length > 0) {
    // Merge into the queue on disk: other servers' proxies and `latch review` write it too.
    await persist(ctx, "pending queue", async () => {
      ctx.pending = await updatePending(ctx.stateDir, (queue) => added.reduce((next, { change }) => enqueue(next, change), queue));
    });
    // In the background: frames are routed one at a time, and a model call must not hold them up.
    for (const { change, tool } of added) if (ctx.advise !== undefined && tool !== undefined) void attachAdvisory(ctx, change, tool);
  }
  for (const event of events) await persist(ctx, "event log", () => appendEvent(ctx.stateDir, event));
}

/**
 * Run the LLM advisory for a queued change and store it on the queued entry: `after.advisory`
 * (kept in latch.lock on approval) and its findings, for the reviewer. Advisory only: the tier is
 * left alone, so it never blocks or unblocks a call, and any failure is logged and ignored.
 */
async function attachAdvisory(ctx: InterceptorContext, change: PendingChange, tool: McpTool): Promise<void> {
  const where = `${ctx.serverId}/${change.toolName}`;
  try {
    const advisory = await ctx.advise!(tool, change.before?.advisory);
    await updatePending(ctx.stateDir, (queue) =>
      queue.some((entry) => entry.id === change.id)
        ? queue.map((entry) =>
            entry.id === change.id ? { ...entry, after: { ...entry.after, advisory }, findings: [...entry.findings, ...advisory.findings] } : entry,
          )
        : queue,
    );
    ctx.log(`${where}: LLM advisory added ${advisory.findings.length} finding(s) for review`);
  } catch (error) {
    ctx.log(`${where}: LLM advisory skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * tools/call request from the client: "respond" with buildBlockError() when blocked, else
 * "forward". A blocked call never reaches the server.
 *
 * Blocked when no tools/list has been analyzed since start or the last list_changed
 * ("unverified": the server may be serving definitions nobody has checked; startProxy holds such
 * calls until a list is analyzed, so this only answers calls whose hold timed out), or when
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
  for (const listing of ctx.ownRequests.values()) listing.stale = true;
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
