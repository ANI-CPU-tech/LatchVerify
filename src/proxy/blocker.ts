import type { LockFile, PendingChange, Tier, ToolRecord } from "../schema/index.js";
import type { JsonRpcId, JsonRpcResponse } from "./transport.js";

/** JSON-RPC server-defined error code used for every LatchVerify block. */
export const BLOCK_ERROR_CODE = -32001;

export type BlockReason =
  | { kind: "unpinned" }
  | { kind: "pending_review"; changeId: string; tier: Tier }
  | { kind: "hard_block"; changeId: string };

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
 */
export function shouldBlock(
  serverId: string,
  toolName: string,
  lockfile: LockFile,
  pending: readonly PendingChange[],
): BlockVerdict {
  const change = blockingChange(serverId, toolName, pending);
  if (change?.tier === 3) return { blocked: true, reason: { kind: "hard_block", changeId: change.id } };
  if (change) return { blocked: true, reason: { kind: "pending_review", changeId: change.id, tier: change.tier } };
  if (pinnedRecord(lockfile, serverId, toolName) === undefined) return { blocked: true, reason: { kind: "unpinned" } };
  return { blocked: false };
}

/** Highest-tier pending change of tier 2 or more for the tool; the first in queue order on a tie. */
function blockingChange(serverId: string, toolName: string, pending: readonly PendingChange[]): PendingChange | undefined {
  let worst: PendingChange | undefined;
  for (const change of pending) {
    if (change.serverId !== serverId || change.toolName !== toolName || change.tier < 2) continue;
    if (worst === undefined || change.tier > worst.tier) worst = change;
  }
  return worst;
}

/** The pinned record, looked up by own keys only so names like "constructor" never resolve. */
function pinnedRecord(lockfile: LockFile, serverId: string, toolName: string): ToolRecord | undefined {
  if (!Object.hasOwn(lockfile.servers, serverId)) return undefined;
  return lockfile.servers[serverId]!.tools.find((tool) => tool.name === toolName);
}

/**
 * Build the JSON-RPC error returned to the client in place of the real tools/call result.
 * TODO: return { jsonrpc, id, error: { code: BLOCK_ERROR_CODE, message, data: { reason } } }
 * where message is written for the model to read and relay, e.g.
 * `LatchVerify blocked "<tool>" pending review — run \`latch review\``. Returning an error
 * (not hanging) makes the agent report the block to the user.
 */
export function buildBlockError(id: JsonRpcId, toolName: string, reason: BlockReason): JsonRpcResponse {
  throw new Error("not implemented");
}
