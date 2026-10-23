import type { LockFile, PendingChange, Tier } from "../schema/index.js";
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
 * TODO: blocked "unpinned" when the tool has no ToolRecord in the lockfile; "hard_block" when
 * a tier-3 change is pending; "pending_review" when a tier-2 change is pending; otherwise
 * not blocked (tier 0/1 changes auto-pass).
 */
export function shouldBlock(
  serverId: string,
  toolName: string,
  lockfile: LockFile,
  pending: readonly PendingChange[],
): BlockVerdict {
  throw new Error("not implemented");
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
