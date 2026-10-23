import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PendingChangeSchema, type PendingChange } from "../schema/index.js";

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

/** Temp file, fsync, rename: the target holds either the old or the new content, never a mix. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
