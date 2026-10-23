import type { PendingChange } from "../schema/index.js";

/** File name of the review queue inside LATCH_STATE_DIR. */
export const PENDING_FILE = "pending.json";

/** TODO: read <stateDir>/pending.json, validate each entry with PendingChangeSchema. Missing file returns []. */
export async function readPending(stateDir: string): Promise<PendingChange[]> {
  throw new Error("not implemented");
}

/** TODO: atomically write the queue to <stateDir>/pending.json, creating stateDir if needed. */
export async function writePending(stateDir: string, changes: readonly PendingChange[]): Promise<void> {
  throw new Error("not implemented");
}

/**
 * TODO: add `change`, replacing any existing entry for the same serverId/toolName (only the
 * latest observed definition is reviewable). Returns the new queue.
 */
export function enqueue(queue: readonly PendingChange[], change: PendingChange): PendingChange[] {
  throw new Error("not implemented");
}

/** TODO: return the queue without the change whose id matches. */
export function dequeue(queue: readonly PendingChange[], id: string): PendingChange[] {
  throw new Error("not implemented");
}
