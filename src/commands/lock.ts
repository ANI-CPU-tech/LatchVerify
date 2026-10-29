import type { Writable } from "node:stream";
import pc from "picocolors";
import type { LockFile } from "../schema/index.js";
import { LockIntegrity, type IntegrityStatus } from "../store/integrity.js";
import { emptyLockfile, parseLockfile, readLockfileText, writeLockfile } from "../store/lockfile.js";
import { printable } from "./text.js";

export interface LockCommandOptions {
  lockfilePath: string;
  /** Where the report goes. Defaults to process.stdout. */
  output?: Writable;
  /** Directory of the integrity records. Defaults to integrityDir(). */
  integrityDir?: string;
}

/** Exit codes of `latch lock status`. */
export const LOCK_STATUS_EXIT = { ok: 0, untrusted: 1 } as const;

const STATUS_TEXT: Record<IntegrityStatus, string> = {
  trusted: "matches what LatchVerify last wrote",
  unrecorded: "has no integrity record yet; LatchVerify records one on its next write",
  untrusted: "was changed outside LatchVerify; running proxies keep the last version LatchVerify wrote",
};

/**
 * `latch lock status`: whether latch.lock is the content LatchVerify last wrote, and if not, how
 * it differs from that version. Exits 1 when it was changed outside LatchVerify.
 */
export async function runLockStatus(options: LockCommandOptions): Promise<number> {
  const { integrity, text, say } = await open(options);
  const status = await integrity.check(text);
  const colour = status === "untrusted" ? pc.red : status === "trusted" ? pc.green : pc.yellow;
  say(`${printable(options.lockfilePath)} ${colour(STATUS_TEXT[status])}`);
  if (status === "untrusted") await showDifference(integrity, text, options.lockfilePath, say);
  return status === "untrusted" ? LOCK_STATUS_EXIT.untrusted : LOCK_STATUS_EXIT.ok;
}

/**
 * `latch lock accept`: trust latch.lock as it is now, after an edit made outside LatchVerify
 * (a `git pull`, a merge, a hand edit). Shows what changed against the last version LatchVerify
 * wrote, then records the current content, so proxies adopt it on their next call.
 *
 * @throws Error when there is no lockfile, or it is not a valid one.
 */
export async function runLockAccept(options: LockCommandOptions): Promise<number> {
  const { integrity, text, say } = await open(options);
  parseLockfile(options.lockfilePath, text); // Never vouch for a file the proxy cannot read.
  if ((await integrity.check(text)) === "trusted") {
    say(`${printable(options.lockfilePath)} already matches what LatchVerify last wrote; nothing to accept`);
    return 0;
  }
  await showDifference(integrity, text, options.lockfilePath, say);
  await integrity.trustContent(text);
  say(pc.green(`accepted ${printable(options.lockfilePath)}: proxies use it from their next tool call`));
  return 0;
}

/**
 * `latch lock restore`: put back the last version of latch.lock that LatchVerify wrote, undoing
 * an edit made outside it.
 *
 * @throws Error when there is no lockfile, or no trusted copy to restore.
 */
export async function runLockRestore(options: LockCommandOptions): Promise<number> {
  const { integrity, text, say } = await open(options);
  if ((await integrity.check(text)) === "trusted") {
    say(`${printable(options.lockfilePath)} already matches what LatchVerify last wrote; nothing to restore`);
    return 0;
  }
  const good = await integrity.lastGood();
  if (good === undefined) {
    throw new Error(`no trusted copy of ${options.lockfilePath} to restore; check it by hand, then run \`latch lock accept\``);
  }
  await writeLockfile(options.lockfilePath, parseLockfile(options.lockfilePath, good));
  say(pc.green(`restored ${printable(options.lockfilePath)} to the last version LatchVerify wrote`));
  return 0;
}

async function open(options: LockCommandOptions) {
  const output = options.output ?? process.stdout;
  const say = (line: string) => void output.write(`${line}\n`);
  const text = await readLockfileText(options.lockfilePath);
  if (text === undefined) throw new Error(`${options.lockfilePath} does not exist`);
  return { integrity: new LockIntegrity(options.lockfilePath, options.integrityDir), text, say };
}

/** Print how `text` differs from the last version LatchVerify wrote, tool by tool. */
async function showDifference(integrity: LockIntegrity, text: string, path: string, say: (line: string) => void): Promise<void> {
  const good = await integrity.lastGood();
  let current: LockFile;
  try {
    current = parseLockfile(path, text);
  } catch (error) {
    say(pc.red(`  it is not a valid lockfile: ${printable(error instanceof Error ? error.message : String(error))}`));
    return;
  }
  const changes = diffLockfiles(good === undefined ? emptyLockfile() : parseLockfile(path, good), current);
  if (good === undefined) say(pc.dim("  no copy of the last trusted version is kept; every pin below counts as new"));
  if (changes.length === 0) say(pc.dim("  same pins as the last trusted version (only formatting or timestamps differ)"));
  for (const line of changes) say(`  ${printable(line)}`);
}

/**
 * Tool by tool, how `after` differs from `before`: "+ server/tool pinned", "- server/tool
 * removed", "~ server/tool definition changed". Ordered by server, then tool.
 */
export function diffLockfiles(before: LockFile, after: LockFile): string[] {
  const pins = (lock: LockFile) => {
    const map = new Map<string, string>();
    for (const [serverId, server] of Object.entries(lock.servers)) {
      for (const tool of server.tools) map.set(`${serverId}/${tool.name}`, tool.hashes.composite);
    }
    return map;
  };
  const was = pins(before);
  const now = pins(after);
  const keys = [...new Set([...was.keys(), ...now.keys()])].sort();
  return keys.flatMap((key) => {
    if (!was.has(key)) return [`+ ${key} pinned`];
    if (!now.has(key)) return [`- ${key} removed`];
    return was.get(key) === now.get(key) ? [] : [`~ ${key} definition changed`];
  });
}
