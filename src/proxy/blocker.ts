import { escapeForEvidence } from "../analyze/unicode.js";
import type { LockFile, PendingChange, Tier, ToolRecord } from "../schema/index.js";
import { findRecord } from "../store/lockfile.js";
import type { JsonRpcId, JsonRpcResponse } from "./transport.js";

/** JSON-RPC server-defined error code used for every LatchVerify block. */
export const BLOCK_ERROR_CODE = -32001;

export type BlockReason =
  /** latch.lock lists the server, but not this tool. */
  | { kind: "unpinned" }
  /** latch.lock does not list the server at all: nothing about it has been pinned. */
  | { kind: "server_unpinned" }
  | { kind: "pending_review"; changeId: string; tier: Tier }
  | { kind: "hard_block"; changeId: string }
  /** Set by the interceptor, not shouldBlock: no tools/list analyzed since start or list_changed. */
  | { kind: "unverified" }
  /** Set by startProxy when routing the call itself failed: it is refused rather than forwarded unchecked. */
  | { kind: "internal_error" };

export type BlockVerdict = { blocked: false } | { blocked: true; reason: BlockReason };

/**
 * Decide whether a tools/call for `toolName` on `serverId` may proceed.
 *
 * Blocked, strongest reason first:
 * - "hard_block" when a tier-3 change to the tool is pending;
 * - "pending_review" when a tier-2 change is pending;
 * - "server_unpinned" when latch.lock does not list the server: approving a single change cannot
 *   help, the server has to be pinned first;
 * - "unpinned" when latch.lock has no record for the tool, whatever the tier of any pending
 *   change (docs/CAPABILITIES.md: a new tool is never callable before review).
 * Otherwise the call proceeds: tier-0 and tier-1 changes auto-pass.
 *
 * A pending change outranks "unpinned" so a poisoned new tool is reported as the hard block it
 * is, with the change id the reviewer needs.
 *
 * A pending change whose `after` hashes are already the pinned ones is ignored: it was approved
 * in latch.lock (for example by a teammate's merged PR) while this machine's queue still holds
 * it, and blocking an approved definition would force a pointless re-review.
 */
export function shouldBlock(
  serverId: string,
  toolName: string,
  lockfile: LockFile,
  pending: readonly PendingChange[],
): BlockVerdict {
  const record = findRecord(lockfile, serverId, toolName);
  const change = blockingChange(serverId, toolName, pending, record);
  if (change?.tier === 3) return { blocked: true, reason: { kind: "hard_block", changeId: change.id } };
  if (change) return { blocked: true, reason: { kind: "pending_review", changeId: change.id, tier: change.tier } };
  if (record === undefined) {
    return { blocked: true, reason: { kind: Object.hasOwn(lockfile.servers, serverId) ? "unpinned" : "server_unpinned" } };
  }
  return { blocked: false };
}

/**
 * Highest-tier pending change of tier 2 or more for the tool that `record` does not already
 * approve; the first in queue order on a tie.
 */
function blockingChange(
  serverId: string,
  toolName: string,
  pending: readonly PendingChange[],
  record: ToolRecord | undefined,
): PendingChange | undefined {
  let worst: PendingChange | undefined;
  for (const change of pending) {
    if (change.serverId !== serverId || change.toolName !== toolName || change.tier < 2) continue;
    if (record !== undefined && change.after.hashes.composite === record.hashes.composite) continue;
    if (worst === undefined || change.tier > worst.tier) worst = change;
  }
  return worst;
}

/** MCP tool names should be at most 128 characters; longer ones are cut in the message. */
const MAX_NAME_IN_MESSAGE = 128;

/**
 * Build the JSON-RPC error returned to the client in place of the real tools/call result:
 * `{ jsonrpc, id, error: { code: BLOCK_ERROR_CODE, message, data: { reason } } }`.
 *
 * The message is written for the model to read and relay to the user, and names the command that
 * resolves the block: `latch review` for a change, `latch init` for a server that was never
 * pinned (a review cannot pin it), or the proxy's stderr for an internal error. Returning an
 * error, not hanging, makes the agent report the block.
 *
 * The tool name comes from the client request, so it is shown as printable ASCII in quotes
 * (invisible and bidi characters as [U+XXXX]) and cut at MAX_NAME_IN_MESSAGE characters: a
 * crafted name cannot hide text in, or flood, the message the model reads.
 */
export function buildBlockError(id: JsonRpcId, toolName: string, reason: BlockReason): JsonRpcResponse {
  const chars = [...toolName];
  const name =
    chars.length > MAX_NAME_IN_MESSAGE
      ? `${escapeForEvidence(chars.slice(0, MAX_NAME_IN_MESSAGE).join(""))} (name truncated)`
      : escapeForEvidence(toolName);
  const message = blockMessage(name, reason);
  return { jsonrpc: "2.0", id, error: { code: BLOCK_ERROR_CODE, message, data: { reason } } };
}

function blockMessage(name: string, reason: BlockReason): string {
  switch (reason.kind) {
    case "server_unpinned":
      return `LatchVerify blocked ${name}: this MCP server is not pinned in latch.lock yet — run \`latch init\` to pin it`;
    case "unpinned":
      return `LatchVerify blocked ${name}: the tool is not approved in latch.lock — run \`latch review\``;
    case "unverified":
      return `LatchVerify blocked ${name}: this server's tools have not been verified yet — retry in a moment, or run \`latch review\` if it stays blocked`;
    case "internal_error":
      return `LatchVerify could not check ${name} because of an internal error; see the proxy's stderr`;
    case "pending_review":
    case "hard_block":
      return `LatchVerify blocked ${name} pending review — run \`latch review\``;
  }
}
