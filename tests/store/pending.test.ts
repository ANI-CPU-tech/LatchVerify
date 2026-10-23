import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockFileSchema, PendingChangeSchema, type PendingChange, type Tier } from "../../src/schema/index.js";
import { PENDING_FILE, readPending, writePending } from "../../src/store/pending.js";

const exampleRecord = (toolName: string) =>
  LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8"))).servers.weather!.tools.find(
    (tool) => tool.name === toolName,
  )!;

/** A schema-valid pending change against a pinned example tool. */
function change(id: string, options: { tier?: Tier; serverId?: string; toolName?: string } = {}): PendingChange {
  const toolName = options.toolName ?? "get_forecast";
  const serverId = options.serverId ?? "weather";
  const before = { ...exampleRecord("get_forecast"), name: toolName, serverId };
  return PendingChangeSchema.parse({
    id,
    serverId,
    toolName,
    tier: options.tier ?? 3,
    detectedAt: "2026-10-21T09:00:00.000Z",
    before,
    after: { ...before, hashes: { ...before.hashes, composite: "0".repeat(64) } },
    capabilityDelta: { gained: ["filesystem.read"], lost: [], loosened: [] },
    findings: [{ type: "pattern", severity: "critical", message: "hidden instruction", evidence: '"you must"' }],
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-pending-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readPending", () => {
  it("returns an empty queue when the file or the state directory is missing", async () => {
    expect(await readPending(dir)).toEqual([]);
    expect(await readPending(join(dir, "missing", "nested"))).toEqual([]);
  });

  it("fails closed, naming the file, when it is not valid JSON", async () => {
    const path = join(dir, PENDING_FILE);
    for (const text of ["", "{", "not json", '[{"id":"a"},]']) {
      await writeFile(path, text);
      await expect(readPending(dir), JSON.stringify(text)).rejects.toThrow(`${path} is not valid JSON`);
    }
  });

  it("fails closed, naming the file and the field, when an entry is invalid", async () => {
    const path = join(dir, PENDING_FILE);
    const bad = { ...change("chg_1"), tier: 7 };
    await writeFile(path, JSON.stringify([change("chg_0"), bad]));
    const error = (await readPending(dir).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`${path} is not a valid pending queue`);
    expect(error.message).toContain("tier");
  });

  it("rejects a file that is not an array of changes", async () => {
    for (const data of [{}, null, "x", change("chg_1")]) {
      await writeFile(join(dir, PENDING_FILE), JSON.stringify(data));
      await expect(readPending(dir)).rejects.toThrow("is not a valid pending queue");
    }
  });

  it("surfaces read errors other than a missing file", async () => {
    await writeFile(join(dir, "file"), "");
    await expect(readPending(join(dir, "file"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("writePending", () => {
  it("round-trips a queue through readPending", async () => {
    const queue = [change("chg_1"), change("chg_2", { tier: 2, toolName: "get_alerts" })];
    await writePending(dir, queue);
    expect(await readPending(dir)).toEqual(queue);
  });

  it("writes 2-space JSON with a trailing newline", async () => {
    const queue = [change("chg_1")];
    await writePending(dir, queue);
    expect(await readFile(join(dir, PENDING_FILE), "utf8")).toBe(`${JSON.stringify(queue, null, 2)}\n`);
  });

  it("writes an empty queue as []", async () => {
    await writePending(dir, []);
    expect(await readFile(join(dir, PENDING_FILE), "utf8")).toBe("[]\n");
    expect(await readPending(dir)).toEqual([]);
  });

  it("creates a missing state directory", async () => {
    const nested = join(dir, "a", "b", ".latch");
    await writePending(nested, [change("chg_1")]);
    expect(await readPending(nested)).toEqual([change("chg_1")]);
  });

  it("replaces the previous queue and leaves no temp files behind", async () => {
    await writePending(dir, [change("chg_1"), change("chg_2", { toolName: "get_alerts" })]);
    await writePending(dir, [change("chg_3")]);
    expect(await readPending(dir)).toEqual([change("chg_3")]);
    expect(await readdir(dir)).toEqual([PENDING_FILE]);
  });

  it("refuses an invalid change without touching the existing file", async () => {
    await writePending(dir, [change("chg_1")]);
    const before = await readFile(join(dir, PENDING_FILE), "utf8");
    const bad = { ...change("chg_2"), detectedAt: "yesterday" } as PendingChange;
    await expect(writePending(dir, [bad])).rejects.toThrow("refusing to write an invalid pending queue");
    expect(await readFile(join(dir, PENDING_FILE), "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual([PENDING_FILE]);
  });

  it("does not create the state directory for an invalid queue", async () => {
    const nested = join(dir, "never");
    await expect(writePending(nested, [{ id: "" } as PendingChange])).rejects.toThrow();
    await expect(readdir(nested)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves one complete queue when writes race", async () => {
    const queues = Array.from({ length: 20 }, (_, i) => [change(`chg_${i}`), change(`chg_${i}b`, { toolName: "get_alerts" })]);
    await Promise.all(queues.map((queue) => writePending(dir, queue)));
    expect(queues).toContainEqual(await readPending(dir));
    expect(await readdir(dir)).toEqual([PENDING_FILE]);
  });

  it("rejects when the state directory cannot be created, and cleans up", async () => {
    await writeFile(join(dir, "file"), "");
    await expect(writePending(join(dir, "file"), [])).rejects.toMatchObject({ code: "EEXIST" });
    await expect(writePending(join(dir, "file", "sub"), [])).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readdir(dir)).toEqual(["file"]);
  });

  it("does not mutate the queue it writes", async () => {
    const queue = [change("chg_1")];
    const before = structuredClone(queue);
    await writePending(dir, queue);
    expect(queue).toEqual(before);
  });
});
