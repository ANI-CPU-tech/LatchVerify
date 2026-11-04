import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** What Windows answers while another process is replacing or holding the target. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface ReplaceOptions {
  platform?: NodeJS.Platform;
  /** How long to keep retrying a busy target. */
  timeoutMs?: number;
  renameFile?: (from: string, to: string) => Promise<void>;
}

/**
 * Renames `from` over `to`, the last step of every atomic write here. POSIX replaces the target at
 * once. Windows refuses with EPERM, EACCES or EBUSY while another process is renaming over the
 * same target or has it open, as when several proxies and the review UI write the queue together.
 * On Windows those errors are retried, with short growing pauses, until `timeoutMs` passes,
 * except when the target is a directory: Windows gives EPERM for that too, and it never clears.
 */
export async function replaceFile(
  from: string,
  to: string,
  { platform = process.platform, timeoutMs = 5_000, renameFile = rename }: ReplaceOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
    try {
      return await renameFile(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || code === undefined || !BUSY_CODES.has(code) || Date.now() + pause > deadline) throw error;
      if ((await stat(to).catch(() => undefined))?.isDirectory()) throw error;
      await sleep(pause);
    }
  }
}

/** Temp file, fsync, rename: the target holds either the old or the new content, never a mix. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
