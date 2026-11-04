import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { appDataDir, platformPath } from "../config/paths.js";
import { withFileLock } from "./lock.js";
import { writeFileAtomic } from "./replace.js";

/**
 * Tamper detection for latch.lock.
 *
 * A guarded server runs as the same OS user as LatchVerify, so it could edit latch.lock to
 * approve its own change. Every time LatchVerify writes a lockfile it first records the content's
 * SHA-256 in a record signed with HMAC-SHA256 under a per-user key, and keeps a copy of that
 * content. A proxy that finds a lockfile whose hash the record does not vouch for keeps the last
 * version it trusted. The key and the records live in the per-user application data directory,
 * outside the state directory, and their location is never put in a server's environment.
 *
 * This detects tampering; it cannot prevent it. A program written against LatchVerify can read
 * the key as easily as LatchVerify can, since both run as the same user.
 */

/**
 * Where the key and the records live: LATCH_INTEGRITY_DIR when set (tests), else `integrity` in
 * the per-user LatchVerify directory, next to the per-user latch.lock.
 */
export function integrityDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.LATCH_INTEGRITY_DIR?.trim();
  if (override) return resolve(override);
  const folder = platform === "win32" || platform === "darwin" ? "LatchVerify" : "latchverify";
  return platformPath(platform).join(appDataDir(platform, env), folder, "integrity");
}

/** What the records say about a lockfile's current content. */
export type IntegrityStatus =
  /** LatchVerify wrote this content (or a person accepted it). */
  | "trusted"
  /** No record for this lockfile yet: written before tamper detection, or by hand from scratch. */
  | "unrecorded"
  /** A record exists and does not vouch for this content, or the record itself was altered. */
  | "untrusted";

const KEY_FILE = "integrity.key";
const RECORD_VERSION = 1;

const RecordSchema = z.object({
  version: z.literal(RECORD_VERSION),
  path: z.string(),
  /** The content written last first, then the one before it (see trustContent). */
  sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(2),
  mac: z.string().regex(/^[a-f0-9]{64}$/),
});
type IntegrityRecord = z.infer<typeof RecordSchema>;

/** Integrity of one lockfile, against the records in `dir`. */
export class LockIntegrity {
  readonly path: string;

  constructor(
    path: string,
    readonly dir: string = integrityDir(),
  ) {
    this.path = resolve(path);
  }

  /** Run `task` with this lockfile's writes held off, in this and every other process. */
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(join(this.dir, `${sha(this.path).slice(0, 32)}.lock`), task);
  }

  /**
   * Record `text` as the lockfile's trusted content and keep a copy of it. Call it before the
   * lockfile itself is replaced: the record vouches for the new content and still for the one
   * it replaces, so a reader between the two writes is never alarmed.
   */
  async trustContent(text: string): Promise<void> {
    const key = await this.key(true);
    const previous = await this.record(key);
    const sha256 = [sha(text), ...(previous ? previous.sha256.slice(0, 1) : [])].filter((value, i, all) => all.indexOf(value) === i);
    await writeFileAtomic(this.file("good"), text);
    const record: IntegrityRecord = { version: RECORD_VERSION, path: this.path, sha256, mac: mac(key!, this.path, sha256) };
    await writeFileAtomic(this.file("json"), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Call once `text` is in place: the record stops vouching for the content it replaced, so an
   * attacker cannot put the previous version back and have it pass.
   */
  async settle(text: string): Promise<void> {
    const key = await this.key(false);
    if (key === undefined) return;
    const sha256 = [sha(text)];
    const record: IntegrityRecord = { version: RECORD_VERSION, path: this.path, sha256, mac: mac(key, this.path, sha256) };
    await writeFileAtomic(this.file("json"), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** What the records say about `text` as this lockfile's content. */
  async check(text: string): Promise<IntegrityStatus> {
    const key = await this.key(false);
    if (key === undefined) return (await this.exists("json")) ? "untrusted" : "unrecorded";
    const record = await this.record(key);
    if (record === null) return "untrusted";
    if (record === undefined) return "unrecorded";
    return record.sha256.includes(sha(text)) ? "trusted" : "untrusted";
  }

  /** The content LatchVerify last wrote, when its record still vouches for it. */
  async lastGood(): Promise<string | undefined> {
    const key = await this.key(false);
    if (key === undefined) return undefined;
    const record = await this.record(key);
    if (!record) return undefined;
    const text = await readText(this.file("good"));
    return text !== undefined && sha(text) === record.sha256[0] ? text : undefined;
  }

  /** The record file. Its content changes whenever trust changes, for callers that watch it. */
  get recordPath(): string {
    return this.file("json");
  }

  private file(extension: "json" | "good"): string {
    // One record per lockfile, named by a hash of its absolute path.
    return join(this.dir, `${sha(this.path).slice(0, 32)}.${extension}`);
  }

  private async exists(extension: "json" | "good"): Promise<boolean> {
    return (await readText(this.file(extension))) !== undefined;
  }

  /** The record, undefined when there is none, null when it is malformed or its MAC is wrong. */
  private async record(key: Buffer | undefined): Promise<IntegrityRecord | undefined | null> {
    const text = await readText(this.file("json"));
    if (text === undefined) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = RecordSchema.safeParse(data);
    if (!parsed.success || key === undefined || parsed.data.path !== this.path) return null;
    const expected = Buffer.from(mac(key, this.path, parsed.data.sha256), "hex");
    return timingSafeEqual(expected, Buffer.from(parsed.data.mac, "hex")) ? parsed.data : null;
  }

  /**
   * The per-user key; created (readable by this user only) when `create` is set and it is missing
   * or damaged. A damaged key is never signed with: without `create` it reads as no key.
   */
  private async key(create: boolean): Promise<Buffer | undefined> {
    const path = join(this.dir, KEY_FILE);
    const existing = await readKey(path);
    if (existing !== undefined) return existing;
    if (!create) return undefined;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await readText(path)) !== undefined) await rm(path, { force: true });
    // Written in full under a private name, then linked into place: link fails when the name is
    // taken, and another process never reads a half-written key.
    const key = randomBytes(32);
    const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${key.toString("hex")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await link(temp, path);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process created it first: use theirs.
      const theirs = await readKey(path);
      if (theirs === undefined) throw new Error(`${path} is not a valid integrity key`, { cause: error });
      return theirs;
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** The key in `path`, undefined when the file is missing or does not hold one. */
async function readKey(path: string): Promise<Buffer | undefined> {
  const text = (await readText(path))?.trim();
  return text !== undefined && /^[a-f0-9]{64}$/.test(text) ? Buffer.from(text, "hex") : undefined;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function mac(key: Buffer, path: string, sha256: readonly string[]): string {
  return createHmac("sha256", key).update(`latch-integrity/${RECORD_VERSION}\n${path}\n${sha256.join(",")}`).digest("hex");
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
