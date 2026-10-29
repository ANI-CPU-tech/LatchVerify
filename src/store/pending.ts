import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { PendingChangeSchema, type PendingChange } from "../schema/index.js";
import { writeFileAtomic } from "./replace.js";

/** File name of the review queue inside LATCH_STATE_DIR. */
export const PENDING_FILE = "pending.json";

const PendingQueueSchema = z.array(PendingChangeSchema);

/**
 * Read <stateDir>/pending.json and validate every entry with PendingChangeSchema. A missing file
 * (or state directory) is an empty queue.
 *
 * @throws Error naming the file when it is not valid JSON or any entry fails validation. The
 * queue is security state: silently dropping a bad entry could unblock a tool still under review,
 * so a damaged queue fails closed instead.
 */
export async function readPending(stateDir: string): Promise<PendingChange[]> {
  const path = join(stateDir, PENDING_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const remedy = "fix or delete it; the proxy queues changes again on the next tools/list";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${(error as Error).message}); ${remedy}`, { cause: error });
  }
  const result = PendingQueueSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`${path} is not a valid pending queue; ${remedy}\n${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Validate the queue, then write it to <stateDir>/pending.json as 2-space JSON with a trailing
 * newline, creating stateDir if needed. The write goes to a temp file in the same directory,
 * is flushed to disk and renamed over the old file, so a reader or a crash never sees half a
 * queue.
 *
 * @throws Error before touching disk when an entry fails PendingChangeSchema, so a bad caller
 * can never leave a queue that readPending refuses.
 */
export async function writePending(stateDir: string, changes: readonly PendingChange[]): Promise<void> {
  const result = PendingQueueSchema.safeParse(changes);
  if (!result.success) {
    throw new Error(`refusing to write an invalid pending queue\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  await mkdir(stateDir, { recursive: true });
  await writeFileAtomic(join(stateDir, PENDING_FILE), `${JSON.stringify(result.data, null, 2)}\n`);
}

/** A lock file older than this is taken to be left behind by a process that crashed holding it. */
export const STALE_LOCK_MS = 10_000;

const LOCK_RETRY_MS = 20;

/**
 * Read-modify-write the queue under an exclusive lock (<stateDir>/pending.json.lock), so the
 * proxies of several servers, `latch review` and the review UI never overwrite each other's
 * changes. `update` gets the queue as it is on disk and returns the new one; returning the same
 * array skips the write. Whatever `update` does besides (writing latch.lock for an approval) also
 * happens under the lock. Returns the queue as written.
 *
 * @throws what readPending, `update` or writePending throws; the lock is released either way.
 */
export async function updatePending(
  stateDir: string,
  update: (queue: PendingChange[]) => PendingChange[] | Promise<PendingChange[]>,
): Promise<PendingChange[]> {
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, `${PENDING_FILE}.lock`);
  await acquireLock(lockPath);
  try {
    const queue = await readPending(stateDir);
    const next = await update(queue);
    if (next !== queue) await writePending(stateDir, next);
    return next;
  } finally {
    await rm(lockPath, { force: true });
  }
}

/** Create `path` exclusively, waiting for its holder to remove it, or for it to go stale. */
async function acquireLock(path: string): Promise<void> {
  for (;;) {
    try {
      await (await open(path, "wx")).close();
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    // shortcut: two waiters can both judge one lock stale and the second removes the first's new
    // lock; only after a crash, within one retry tick. Upgrade to an fs lock library if it bites.
    if (age > STALE_LOCK_MS) await rm(path, { force: true });
    else await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Add `change` to the end of the queue, dropping any entry for the same serverId/toolName (only
 * the latest observed definition is reviewable) and any entry with the same id (ids stay
 * unique, so dequeue removes exactly one change). Pure: returns a new array.
 */
export function enqueue(queue: readonly PendingChange[], change: PendingChange): PendingChange[] {
  const kept = queue.filter(
    (entry) => entry.id !== change.id && (entry.serverId !== change.serverId || entry.toolName !== change.toolName),
  );
  return [...kept, change];
}

/**
 * Review order: highest tier first, then oldest first. Use with a stable sort: changes detected
 * together keep their queue order, which is the order the server listed the tools.
 */
export function reviewOrder(a: PendingChange, b: PendingChange): number {
  return b.tier - a.tier || Date.parse(a.detectedAt) - Date.parse(b.detectedAt);
}

/** The queue without the change whose id matches; unchanged contents when none does. Pure. */
export function dequeue(queue: readonly PendingChange[], id: string): PendingChange[] {
  return queue.filter((entry) => entry.id !== id);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
