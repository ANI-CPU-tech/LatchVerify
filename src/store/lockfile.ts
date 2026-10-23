import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { LOCKFILE_VERSION, LockFileSchema, type LockFile, type PendingChange, type ToolRecord } from "../schema/index.js";

/** Any failure to read, validate or write latch.lock. The message always names the file. */
export class LockfileError extends Error {
  override readonly name = "LockfileError";

  constructor(
    readonly path: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${path}: ${message}`, options);
  }
}

/** Timestamp of a lockfile that was never written: the Unix epoch, so empty lockfiles compare equal. */
const NEVER_GENERATED = new Date(0).toISOString();

/** The lockfile `latch init` starts from: current format, no servers. */
export function emptyLockfile(): LockFile {
  return { version: LOCKFILE_VERSION, generatedAt: NEVER_GENERATED, servers: {} };
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/**
 * Validates parsed JSON as a lockfile this version of latch understands. Throws LockfileError
 * listing every schema problem with its field path, or an unsupported version.
 */
function validateLockfile(path: string, data: unknown): LockFile {
  const result = LockFileSchema.safeParse(data);
  if (!result.success) throw new LockfileError(path, `invalid lockfile\n${z.prettifyError(result.error)}`, { cause: result.error });
  if (result.data.version !== LOCKFILE_VERSION) {
    throw new LockfileError(path, `unsupported lockfile version "${result.data.version}" (this latch reads version "${LOCKFILE_VERSION}")`);
  }
  return result.data;
}

/**
 * Reads and validates latch.lock. A missing file returns emptyLockfile() so `latch init` can
 * bootstrap; a leading UTF-8 byte-order mark is ignored. Anything else that is wrong (unreadable
 * file, invalid JSON, schema violations, a newer format version) throws LockfileError naming the
 * file: a lockfile that cannot be trusted must never be treated as empty.
 */
export async function readLockfile(path: string): Promise<LockFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyLockfile();
    throw new LockfileError(path, `cannot read lockfile (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }

  let data: unknown;
  try {
    data = JSON.parse(text.startsWith("\ufeff") ? text.slice(1) : text);
  } catch (error) {
    throw new LockfileError(path, `not valid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  return validateLockfile(path, data);
}

/** Plain code-unit order, so the output never depends on the machine's locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * latch.lock exactly as it is written to disk: servers sorted by id, tools by name, object keys
 * in schema order, 2-space JSON and a trailing newline. The same approved state always gives the
 * same bytes, so git diffs show only real changes. Expects a lockfile that passed validation.
 */
export function serializeLockfile(lock: LockFile): string {
  const servers = Object.fromEntries(
    Object.keys(lock.servers)
      .sort(byCodeUnit)
      .map((id) => {
        const server = lock.servers[id]!;
        return [id, { ...server, tools: [...server.tools].sort((a, b) => byCodeUnit(a.name, b.name)) }];
      }),
  );
  return `${JSON.stringify({ ...lock, servers }, null, 2)}\n`;
}

/** Flushes a directory entry after a rename. Not every platform can open directories (Windows). */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the rename itself has already completed.
  }
}

/**
 * Validates `lock` and writes it atomically: the serialized text goes to a new temporary file in
 * the same directory, is flushed to disk, then renamed over `path`. Readers and crashes see
 * either the old lockfile or the new one, never a partial write. Parent directories are created.
 * Throws LockfileError, leaving any existing file untouched, when `lock` is invalid or the write
 * fails.
 */
export async function writeLockfile(path: string, lock: LockFile): Promise<void> {
  const text = serializeLockfile(validateLockfile(path, lock));
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw new LockfileError(path, `cannot write lockfile (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  await syncDirectory(dir);
}

/**
 * The pinned record for serverId/toolName, or undefined when the tool is not pinned. Only the
 * lockfile's own entries count: an id such as "constructor" never resolves to an Object.prototype
 * member.
 */
export function findRecord(lock: LockFile, serverId: string, toolName: string): ToolRecord | undefined {
  if (!Object.hasOwn(lock.servers, serverId)) return undefined;
  return lock.servers[serverId]!.tools.find((tool) => tool.name === toolName);
}

/**
 * Approve a pending change.
 * TODO: return a new LockFile with change.after (approvedBy/approvedAt set) replacing or adding
 * the record, and generatedAt bumped. Pure: does not touch disk.
 */
export function applyApproval(lock: LockFile, change: PendingChange, approvedBy: string, now: Date): LockFile {
  throw new Error("not implemented");
}
