import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockFileSchema, PendingChangeSchema, type PendingChange, type Tier } from "../../src/schema/index.js";
import { PENDING_FILE, STALE_LOCK_MS, dequeue, enqueue, readPending, updatePending, writePending } from "../../src/store/pending.js";

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

describe("enqueue", () => {
  const ids = (queue: readonly PendingChange[]) => queue.map((entry) => entry.id);

  it("appends a change for a new tool", () => {
    const queue = enqueue(enqueue([], change("chg_1")), change("chg_2", { toolName: "get_alerts" }));
    expect(ids(queue)).toEqual(["chg_1", "chg_2"]);
  });

  it("replaces the entry for the same server and tool with the latest change", () => {
    const queue = [change("chg_1"), change("chg_2", { toolName: "get_alerts" })];
    const latest = change("chg_3", { tier: 2 });
    expect(enqueue(queue, latest)).toEqual([queue[1], latest]);
  });

  it("keeps entries for the same tool name on another server", () => {
    const queue = [change("chg_1", { serverId: "other" })];
    expect(ids(enqueue(queue, change("chg_2")))).toEqual(["chg_1", "chg_2"]);
  });

  it("drops an entry that reuses the new change's id, keeping ids unique", () => {
    const queue = [change("chg_1", { toolName: "get_alerts" })];
    expect(enqueue(queue, change("chg_1"))).toEqual([change("chg_1")]);
  });

  it("removes every stale entry for the tool, even duplicates", () => {
    const queue = [change("chg_1"), change("chg_2", { toolName: "get_alerts" }), change("chg_3")];
    expect(ids(enqueue(queue, change("chg_4")))).toEqual(["chg_2", "chg_4"]);
  });

  it("does not mutate the queue", () => {
    const queue = [change("chg_1")];
    const before = structuredClone(queue);
    const next = enqueue(queue, change("chg_2"));
    expect(queue).toEqual(before);
    expect(next).not.toBe(queue);
  });
});

describe("dequeue", () => {
  it("removes the change with the given id", () => {
    const queue = [change("chg_1"), change("chg_2", { toolName: "get_alerts" })];
    expect(dequeue(queue, "chg_1")).toEqual([queue[1]]);
  });

  it("returns an equal copy when no change matches", () => {
    const queue = [change("chg_1")];
    const next = dequeue(queue, "chg_missing");
    expect(next).toEqual(queue);
    expect(next).not.toBe(queue);
    expect(dequeue([], "chg_1")).toEqual([]);
  });

  it("matches ids exactly", () => {
    const queue = [change("chg_1")];
    for (const id of ["CHG_1", "chg_1 ", "chg_", ""]) expect(dequeue(queue, id)).toEqual(queue);
  });

  it("does not mutate the queue", () => {
    const queue = [change("chg_1")];
    const before = structuredClone(queue);
    dequeue(queue, "chg_1");
    expect(queue).toEqual(before);
  });

  it("round-trips through disk with enqueue and writePending", async () => {
    let queue = await readPending(dir);
    queue = enqueue(queue, change("chg_1"));
    queue = enqueue(queue, change("chg_2", { toolName: "get_alerts" }));
    await writePending(dir, queue);
    await writePending(dir, dequeue(await readPending(dir), "chg_1"));
    expect(await readPending(dir)).toEqual([change("chg_2", { toolName: "get_alerts" })]);
  });
});

describe("updatePending", () => {
  it("loses no update when many writers race (one proxy per server, review, the UI)", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `chg_${i}`);
    await Promise.all(ids.map((id, i) => updatePending(dir, (queue) => enqueue(queue, change(id, { toolName: `tool_${i}` })))));
    expect((await readPending(dir)).map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect(await readdir(dir)).toEqual([PENDING_FILE]);
  });

  it("skips the write when the update returns the same queue, and returns the queue as written", async () => {
    expect(await updatePending(dir, (queue) => queue)).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(await updatePending(dir, (queue) => enqueue(queue, change("chg_a")))).toMatchObject([{ id: "chg_a" }]);
  });

  it("releases the lock when the update throws", async () => {
    await expect(updatePending(dir, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await updatePending(dir, (queue) => enqueue(queue, change("chg_a")))).toHaveLength(1);
  });

  it("takes over a lock left behind by a crashed process", async () => {
    const lock = join(dir, `${PENDING_FILE}.lock`);
    await writeFile(lock, "");
    const old = (Date.now() - STALE_LOCK_MS - 1_000) / 1000;
    await utimes(lock, old, old);
    expect(await updatePending(dir, (queue) => enqueue(queue, change("chg_a")))).toHaveLength(1);
  });
});
