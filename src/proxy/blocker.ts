import { escapeForEvidence } from "../analyze/unicode.js";
import type { LockFile, PendingChange, Tier, ToolRecord } from "../schema/index.js";
import { findRecord } from "../store/lockfile.js";
import type { JsonRpcId, JsonRpcResponse } from "./transport.js";

/** JSON-RPC server-defined error code used for every LatchVerify block. */
export const BLOCK_ERROR_CODE = -32001;

export type BlockReason =
  | { kind: "unpinned" }
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
  if (record === undefined) return { blocked: true, reason: { kind: "unpinned" } };
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

/** The pinned record, looked up by own keys only so names like "constructor" never resolve. */
/** MCP tool names should be at most 128 characters; longer ones are cut in the message. */
const MAX_NAME_IN_MESSAGE = 128;

/**
 * Build the JSON-RPC error returned to the client in place of the real tools/call result:
 * `{ jsonrpc, id, error: { code: BLOCK_ERROR_CODE, message, data: { reason } } }`.
 *
 * The message is written for the model to read and relay to the user, and names `latch review`
 * (or, for an internal error, the proxy's stderr). Returning an error, not hanging, makes the agent report the block.
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
  const message =
    reason.kind === "unpinned"
      ? `LatchVerify blocked ${name}: the tool is not approved in latch.lock — run \`latch review\``
      : reason.kind === "unverified"
        ? `LatchVerify blocked ${name}: this server's tools have not been verified yet — retry in a moment, or run \`latch review\` if it stays blocked`
        : reason.kind === "internal_error"
          ? `LatchVerify could not check ${name} because of an internal error; see the proxy's stderr`
          : `LatchVerify blocked ${name} pending review — run \`latch review\``;
  return { jsonrpc: "2.0", id, error: { code: BLOCK_ERROR_CODE, message, data: { reason } } };
}
