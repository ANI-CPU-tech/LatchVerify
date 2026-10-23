import type { LockFile, PendingChange } from "../schema/index.js";
import type { Direction, Frame, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./transport.js";

/** What the proxy does with one frame. */
export type InterceptDecision =
  /** Pass the original raw line through unchanged. */
  | { action: "forward" }
  /** Pass a modified message onward in the same direction. */
  | { action: "rewrite"; message: JsonRpcMessage }
  /** Swallow the frame and reply to its sender instead (used to block tools/call). */
  | { action: "respond"; message: JsonRpcResponse };

/** Mutable per-connection state shared by the handlers below. */
export interface InterceptorContext {
  serverId: string;
  lockfile: LockFile;
  pending: PendingChange[];
  /** Client request ids awaiting a server response, mapped to their method. */
  inflight: Map<JsonRpcId, string>;
  /** MCP protocol revision negotiated in `initialize`. */
  specVersion: string | null;
}

/**
 * Entry point for every frame.
 * TODO: record client request ids in ctx.inflight; dispatch tools/call requests to
 * onToolsCall, tools/list responses (matched via inflight) to onToolsList, and
 * notifications/tools/list_changed to onToolsListChanged; capture specVersion from the
 * initialize response. Everything else, and every unparseable frame, is "forward".
 */
export async function routeFrame(ctx: InterceptorContext, direction: Direction, frame: Frame): Promise<InterceptDecision> {
  throw new Error("not implemented");
}

/**
 * tools/list response from the server.
 * TODO: validate result with McpToolListSchema, then per tool: hash segments, extract
 * capabilities, run detectors, diff against the lockfile record, classify a tier, and append
 * a PendingChange for anything that is new or changed. Tier 0/1 auto-pass and are logged.
 * Returns "forward": the client still sees the list; enforcement happens at tools/call.
 */
export async function onToolsList(ctx: InterceptorContext, response: JsonRpcResponse): Promise<InterceptDecision> {
  throw new Error("not implemented");
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
