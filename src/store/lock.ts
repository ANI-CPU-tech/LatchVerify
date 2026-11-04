import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** A lock file not touched for this long is taken to be left behind by a process that crashed. */
export const STALE_LOCK_MS = 10_000;

const RETRY_MS = 20;

/**
 * Run `task` while holding an exclusive lock on `path`, a file created for the purpose, and
 * remove it afterwards, whether `task` succeeds or throws.
 *
 * The lock file holds a random owner token. While `task` runs, the holder touches the file four
 * times per `staleMs`, so only a lock whose holder died goes stale. A waiter takes a stale lock over by
 * renaming it to a private name (only one waiter can win that rename) and checking that the
 * renamed file still holds the token it judged stale; if a live holder's lock was caught instead,
 * it is linked back. Release removes the file only while it still holds the holder's own token.
 */
export async function withFileLock<T>(path: string, task: () => Promise<T>, { staleMs = STALE_LOCK_MS } = {}): Promise<T> {
  const token = await acquire(path, staleMs);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, staleMs / 4);
  heartbeat.unref();
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    if ((await readToken(path)) === token) await rm(path, { force: true });
  }
}

async function acquire(path: string, staleMs: number): Promise<string> {
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age > staleMs) await takeOver(path);
    else await sleep(RETRY_MS);
  }
}

/** Remove a stale lock at `path`, making sure it is the stale one that goes. */
async function takeOver(path: string): Promise<void> {
  const stale = await readToken(path);
  if (stale === undefined) return;
  const moved = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, moved);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return; // Another waiter took it over first.
    throw error;
  }
  if ((await readToken(moved)) !== stale) {
    // A waiter removed the stale lock and a new holder created this one meanwhile: give it back.
    await link(moved, path).catch(() => {});
  }
  await rm(moved, { force: true });
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
