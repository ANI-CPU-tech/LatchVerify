import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { appDataDir, platformPath } from "../config/paths.js";
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

  /** The per-user key; created (readable by this user only) when `create` is set and it is missing. */
  private async key(create: boolean): Promise<Buffer | undefined> {
    const path = join(this.dir, KEY_FILE);
    const existing = await readText(path);
    if (existing !== undefined) return Buffer.from(existing.trim(), "hex");
    if (!create) return undefined;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${key.toString("hex")}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return key;
    } catch (error) {
      // Another process created it first: use theirs.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return Buffer.from((await readFile(path, "utf8")).trim(), "hex");
      throw error;
    }
  }
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
