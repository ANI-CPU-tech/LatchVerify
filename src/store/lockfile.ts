import { readFile } from "node:fs/promises";
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
