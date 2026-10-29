import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { LOCKFILE_VERSION, LockFileSchema, type LockFile, type PendingChange, type ToolRecord } from "../schema/index.js";
import { LockIntegrity } from "./integrity.js";
import { replaceFile } from "./replace.js";

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
  const text = await readLockfileText(path);
  return text === undefined ? emptyLockfile() : parseLockfile(path, text);
}

/**
 * The raw text of latch.lock, or undefined when the file does not exist, for callers that check
 * the exact bytes (tamper detection) before parsing them with parseLockfile.
 *
 * @throws LockfileError when the file exists but cannot be read.
 */
export async function readLockfileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new LockfileError(path, `cannot read lockfile (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
}

/** Parse and validate lockfile text read from `path`, as readLockfile does. */
export function parseLockfile(path: string, text: string): LockFile {
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
 *
 * Before the rename, the new content is recorded as trusted (LockIntegrity.trustContent), so
 * proxies accept it and treat any edit made outside LatchVerify as tampering.
 *
 * Throws LockfileError, leaving any existing file untouched, when `lock` is invalid, its
 * integrity cannot be recorded, or the write fails.
 */
export async function writeLockfile(path: string, lock: LockFile): Promise<void> {
  const text = serializeLockfile(validateLockfile(path, lock));
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await new LockIntegrity(path).trustContent(text);
  } catch (error) {
    throw new LockfileError(path, `cannot record the lockfile's integrity (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temp, path);
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
 * Approves a pending change: returns a new lockfile in which `change.after` replaces (or adds)
 * the tool's record, stamped with the approver and approval time, with tools kept sorted and
 * generatedAt set to `now`. Pure: neither argument is modified and nothing touches disk; persist
 * the result with writeLockfile, then commit latch.lock for review.
 *
 * Throws when the approval cannot be recorded faithfully: a blank approver, an invalid date, a
 * change whose record describes a different tool, a server the lockfile does not list (a pending
 * change carries no launch command; `latch init` adds servers), or a result that fails validation.
 */
export function applyApproval(lock: LockFile, change: PendingChange, approvedBy: string, now: Date): LockFile {
  const approver = approvedBy.trim();
  if (approver.length === 0) throw new TypeError("applyApproval: approvedBy must not be empty");
  if (Number.isNaN(now.getTime())) throw new RangeError("applyApproval: now is not a valid date");
  const { after } = change;
  if (after.serverId !== change.serverId || after.name !== change.toolName) {
    throw new Error(
      `applyApproval: change ${change.id} is for ${change.serverId}/${change.toolName} but its record describes ${after.serverId}/${after.name}`,
    );
  }
  if (!Object.hasOwn(lock.servers, change.serverId)) {
    throw new Error(`applyApproval: server "${change.serverId}" is not in the lockfile; add it with \`latch init\` first`);
  }

  const approvedAt = now.toISOString();
  const next = structuredClone(lock);
  const server = next.servers[change.serverId]!;
  const record: ToolRecord = { ...structuredClone(after), approvedBy: approver, approvedAt };
  server.tools = [...server.tools.filter((tool) => tool.name !== record.name), record].sort((a, b) => byCodeUnit(a.name, b.name));
  next.generatedAt = approvedAt;

  const result = LockFileSchema.safeParse(next);
  if (!result.success) throw new Error(`applyApproval: the approved lockfile would be invalid\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Adds the servers `serverIds` of `pinned` to `current`, the lockfile as it is on disk now, for
 * commands that pin servers outside the state lock and write under it (init, add, the background
 * sync). A server `current` already has was pinned or approved by someone else meanwhile: it is
 * kept as it is and reported in `taken`, never overwritten. Pure.
 */
export function mergeServers(current: LockFile, pinned: LockFile, serverIds: readonly string[]): { lock: LockFile; added: string[]; taken: string[] } {
  const added: string[] = [];
  const taken: string[] = [];
  const servers = { ...current.servers };
  for (const id of serverIds) {
    if (!Object.hasOwn(pinned.servers, id)) throw new Error(`mergeServers: server "${id}" is not in the pinned lockfile`);
    if (Object.hasOwn(servers, id)) {
      taken.push(id);
      continue;
    }
    servers[id] = structuredClone(pinned.servers[id]!);
    added.push(id);
  }
  if (added.length === 0) return { lock: current, added, taken };
  return { lock: { ...current, generatedAt: pinned.generatedAt, servers }, added, taken };
}

/**
 * `lock` with `serverId` linked: its launch command and no tools, marked trustOnFirstUse, so the
 * proxy pins the tools the first time the server lists them (pinFirstRun). Linking starts nothing,
 * so it never needs the keys in the client's config. Pure.
 *
 * @throws Error when `lock` already has the server: its pins are changed through review, never by
 * linking again.
 */
export function linkServer(lock: LockFile, serverId: string, command: string, args: readonly string[], now: Date): LockFile {
  if (Object.hasOwn(lock.servers, serverId)) throw new Error(`linkServer: server "${serverId}" is already in the lockfile`);
  return {
    ...lock,
    generatedAt: now.toISOString(),
    servers: { ...lock.servers, [serverId]: { transport: "stdio", command, args: [...args], tools: [], trustOnFirstUse: true } },
  };
}

/**
 * Trust on first use, for a server linked with linkServer: approves every change in `changes`
 * (the server's first tool list) that has no critical finding, under `approvedBy`, and clears
 * trustOnFirstUse. A tool with a critical finding (hidden instructions, invisible or bidi text, a
 * reference to another server) is left out, for the proxy to queue for review. Pure; a server
 * that is not marked trustOnFirstUse is returned unchanged with nothing pinned.
 */
export function pinFirstRun(
  lock: LockFile,
  serverId: string,
  changes: readonly PendingChange[],
  approvedBy: string,
  now: Date,
): { lock: LockFile; pinned: string[]; held: string[] } {
  const server = Object.hasOwn(lock.servers, serverId) ? lock.servers[serverId]! : undefined;
  if (server?.trustOnFirstUse !== true) return { lock, pinned: [], held: [] };
  let next = lock;
  const pinned: string[] = [];
  const held: string[] = [];
  for (const change of changes) {
    if (change.serverId !== serverId) continue;
    if (change.findings.some((finding) => finding.severity === "critical")) {
      held.push(change.toolName);
      continue;
    }
    next = applyApproval(next, change, approvedBy, now);
    pinned.push(change.toolName);
  }
  const { trustOnFirstUse: _done, ...linked } = next.servers[serverId]!;
  return { lock: { ...next, generatedAt: now.toISOString(), servers: { ...next.servers, [serverId]: linked } }, pinned, held };
}
