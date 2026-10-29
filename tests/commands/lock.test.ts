import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_STATUS_EXIT, diffLockfiles, runLockAccept, runLockRestore, runLockStatus } from "../../src/commands/lock.js";
import { LockFileSchema, type LockFile } from "../../src/schema/index.js";
import { LockIntegrity } from "../../src/store/integrity.js";
import { serializeLockfile, writeLockfile } from "../../src/store/lockfile.js";

const example = (): LockFile => LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")));

let dir: string;
let lockfilePath: string;
let records: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-lock-cmd-"));
  lockfilePath = join(dir, "latch.lock");
  records = join(dir, "records");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run a lock command and collect what it printed, without colours. */
async function cli(command: typeof runLockStatus) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await command({ lockfilePath, output, integrityDir: records });
  return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
}

/** latch.lock written by LatchVerify, then edited by hand: get_alerts removed. */
async function tampered(): Promise<LockFile> {
  const trusted = example();
  const text = serializeLockfile(trusted);
  await new LockIntegrity(lockfilePath, records).trustContent(text);
  await writeFile(lockfilePath, text);
  const edited = structuredClone(trusted);
  edited.servers.weather!.tools = edited.servers.weather!.tools.filter((tool) => tool.name !== "get_alerts");
  await writeFile(lockfilePath, serializeLockfile(edited));
  return trusted;
}

describe("latch lock status", () => {
  it("reports a lockfile LatchVerify wrote", async () => {
    const text = serializeLockfile(example());
    await new LockIntegrity(lockfilePath, records).trustContent(text);
    await writeFile(lockfilePath, text);
    expect(await cli(runLockStatus)).toEqual({ code: LOCK_STATUS_EXIT.ok, text: `${lockfilePath} matches what LatchVerify last wrote\n` });
  });

  it("reports a lockfile with no record yet without failing", async () => {
    await writeFile(lockfilePath, serializeLockfile(example()));
    const { code, text } = await cli(runLockStatus);
    expect(code).toBe(LOCK_STATUS_EXIT.ok);
    expect(text).toContain("has no integrity record yet");
  });

  it("fails on an edit made outside LatchVerify and shows what changed", async () => {
    await tampered();
    const { code, text } = await cli(runLockStatus);
    expect(code).toBe(LOCK_STATUS_EXIT.untrusted);
    expect(text).toContain("was changed outside LatchVerify");
    expect(text).toContain("  - weather/get_alerts removed\n");
  });

  it("refuses a missing lockfile", async () => {
    await expect(cli(runLockStatus)).rejects.toThrow("does not exist");
  });
});

describe("latch lock accept", () => {
  it("trusts the edited lockfile after showing the difference", async () => {
    await tampered();
    const { code, text } = await cli(runLockAccept);
    expect(code).toBe(0);
    expect(text).toContain("  - weather/get_alerts removed\n");
    expect(text).toContain(`accepted ${lockfilePath}`);
    expect(await new LockIntegrity(lockfilePath, records).check(await readFile(lockfilePath, "utf8"))).toBe("trusted");
  });

  it("refuses to vouch for a file that is not a valid lockfile", async () => {
    await writeFile(lockfilePath, "{ nope");
    await expect(cli(runLockAccept)).rejects.toThrow("not valid JSON");
  });

  it("says when there is nothing to accept", async () => {
    await writeLockfile(lockfilePath, example());
    const output = new PassThrough();
    expect(await runLockAccept({ lockfilePath, output })).toBe(0);
  });
});

describe("latch lock restore", () => {
  it("puts back the last version LatchVerify wrote", async () => {
    const trusted = await tampered();
    const { code, text } = await cli(runLockRestore);
    expect(code).toBe(0);
    expect(text).toContain(`restored ${lockfilePath}`);
    expect(await readFile(lockfilePath, "utf8")).toBe(serializeLockfile(trusted));
  });

  it("refuses when no trusted copy exists", async () => {
    await writeFile(lockfilePath, serializeLockfile(example()));
    const integrity = new LockIntegrity(lockfilePath, records);
    await integrity.trustContent("something else");
    await rm(join(records, "integrity.key"));
    await expect(cli(runLockRestore)).rejects.toThrow("no trusted copy");
  });
});

describe("diffLockfiles", () => {
  it("lists pinned, removed and changed tools in order", () => {
    const before = example();
    const after = structuredClone(before);
    const tools = after.servers.weather!.tools;
    after.servers.weather!.tools = tools.filter((tool) => tool.name !== "get_alerts");
    after.servers.weather!.tools.find((tool) => tool.name === "get_forecast")!.hashes.composite = "f".repeat(64);
    after.servers.other = { ...structuredClone(before.servers.weather!), tools: tools.filter((tool) => tool.name === "get_alerts") };
    expect(diffLockfiles(before, after)).toEqual(["+ other/get_alerts pinned", "- weather/get_alerts removed", "~ weather/get_forecast definition changed"]);
    expect(diffLockfiles(before, before)).toEqual([]);
  });
});
