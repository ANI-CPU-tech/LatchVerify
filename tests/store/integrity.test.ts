import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockIntegrity, integrityDir } from "../../src/store/integrity.js";

let dir: string;
let records: string;
const lockPath = () => join(dir, "latch.lock");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-integrity-test-"));
  records = join(dir, "records");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const recordFile = async () => join(records, (await readdir(records)).find((name) => name.endsWith(".json"))!);

describe("LockIntegrity", () => {
  it("knows nothing about a lockfile it never recorded", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    expect(await integrity.check("{}")).toBe("unrecorded");
    expect(await integrity.lastGood()).toBeUndefined();
  });

  it("trusts exactly the content it recorded, and keeps a copy of it", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    await integrity.trustContent("v1\n");
    expect(await integrity.check("v1\n")).toBe("trusted");
    expect(await integrity.check("v1")).toBe("untrusted");
    expect(await integrity.lastGood()).toBe("v1\n");
  });

  it("still trusts the content a write replaces, but not the one before it", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    for (const text of ["v1", "v2", "v3"]) await integrity.trustContent(text);
    expect(await integrity.check("v3")).toBe("trusted");
    expect(await integrity.check("v2")).toBe("trusted");
    expect(await integrity.check("v1")).toBe("untrusted");
    expect(await integrity.lastGood()).toBe("v3");
  });

  it("rejects a record whose hashes were edited, since its MAC no longer matches", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    await integrity.trustContent("v1");
    const file = await recordFile();
    const record = JSON.parse(await readFile(file, "utf8"));
    record.sha256 = ["0".repeat(64)];
    await writeFile(file, JSON.stringify(record));
    expect(await integrity.check("v1")).toBe("untrusted");
    expect(await integrity.lastGood()).toBeUndefined();
  });

  it("does not let one lockfile's record vouch for another", async () => {
    const first = new LockIntegrity(lockPath(), records);
    await first.trustContent("same");
    const other = new LockIntegrity(join(dir, "other", "latch.lock"), records);
    expect(await other.check("same")).toBe("unrecorded");
  });

  it("does not hand out a last-good copy that was edited", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    await integrity.trustContent("v1");
    const good = join(records, (await readdir(records)).find((name) => name.endsWith(".good"))!);
    await writeFile(good, "edited");
    expect(await integrity.lastGood()).toBeUndefined();
  });

  it("treats a record without its key as untrusted", async () => {
    const integrity = new LockIntegrity(lockPath(), records);
    await integrity.trustContent("v1");
    await rm(join(records, "integrity.key"));
    expect(await integrity.check("v1")).toBe("untrusted");
  });

  it.skipIf(process.platform === "win32")("keeps the key readable by this user only", async () => {
    await new LockIntegrity(lockPath(), records).trustContent("v1");
    expect((await stat(join(records, "integrity.key"))).mode & 0o077).toBe(0);
    expect((await stat(records)).mode & 0o077).toBe(0);
  });

  it("names the same record for a relative and an absolute path", async () => {
    await new LockIntegrity(lockPath(), records).trustContent("v1");
    const relative = new LockIntegrity(join(dir, ".", "latch.lock"), records);
    expect(relative.path).toBe(resolve(lockPath()));
    expect(await relative.check("v1")).toBe("trusted");
  });
});

describe("integrityDir", () => {
  it("honours LATCH_INTEGRITY_DIR", () => {
    expect(integrityDir({ LATCH_INTEGRITY_DIR: "/tmp/x" }, "linux")).toBe(resolve("/tmp/x"));
  });

  it("sits next to the per-user lockfile on each platform", () => {
    expect(integrityDir({ XDG_CONFIG_HOME: "/home/u/.config" }, "linux")).toBe("/home/u/.config/latchverify/integrity");
    expect(integrityDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toBe("C:\\Users\\u\\AppData\\Roaming\\LatchVerify\\integrity");
  });
});
