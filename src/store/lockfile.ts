import type { LockFile, PendingChange, ToolRecord } from "../schema/index.js";

/**
 * TODO: read and JSON.parse `path`, validate with LockFileSchema, and throw a readable error
 * naming the bad path on failure. A missing file returns an empty lockfile (version
 * LOCKFILE_VERSION, no servers) so `latch init` can bootstrap.
 */
export async function readLockfile(path: string): Promise<LockFile> {
  throw new Error("not implemented");
}

/**
 * TODO: validate, then write `lock` as 2-space JSON with servers and tools sorted by key/name
 * and a trailing newline, so git diffs on latch.lock are stable and reviewable. Write to a temp
 * file and rename for atomicity.
 */
export async function writeLockfile(path: string, lock: LockFile): Promise<void> {
  throw new Error("not implemented");
}

/** TODO: return the pinned record for serverId/toolName, or undefined if unpinned. */
export function findRecord(lock: LockFile, serverId: string, toolName: string): ToolRecord | undefined {
  throw new Error("not implemented");
}

/**
 * Approve a pending change.
 * TODO: return a new LockFile with change.after (approvedBy/approvedAt set) replacing or adding
 * the record, and generatedAt bumped. Pure: does not touch disk.
 */
export function applyApproval(lock: LockFile, change: PendingChange, approvedBy: string, now: Date): LockFile {
  throw new Error("not implemented");
}
