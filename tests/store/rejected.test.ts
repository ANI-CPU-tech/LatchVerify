import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeToolList } from "../../src/proxy/analysis.js";
import { LockFileSchema, type PendingChange, type Rejection } from "../../src/schema/index.js";
import { MAX_REJECTIONS, REJECTED_FILE, addRejection, findRejection, readRejected, writeRejected } from "../../src/store/rejected.js";

const lock = LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")));
const poisoned = JSON.parse(readFileSync(new URL("../fixtures/poisoned-tools.json", import.meta.url), "utf8")).tools as unknown[];
const changes: PendingChange[] = analyzeToolList("weather", { tools: poisoned }, lock, "2025-06-18", new Date("2026-10-23T09:00:00.000Z"))!.changes.map(
  ({ change }) => change,
);
const now = new Date("2026-10-29T10:00:00.000Z");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-rejected-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readRejected and writeRejected", () => {
  it("reads a missing file as no rejections", async () => {
    expect(await readRejected(join(dir, "missing"))).toEqual([]);
  });

  it("round-trips a list, creating the state directory", async () => {
    const list = addRejection([], changes[0]!, now);
    const stateDir = join(dir, ".latch");
    await writeRejected(stateDir, list);
    expect(await readRejected(stateDir)).toEqual(list);
  });

  it("refuses a damaged file instead of forgetting rejections", async () => {
    await writeFile(join(dir, REJECTED_FILE), "{ nope");
    await expect(readRejected(dir)).rejects.toThrow(`${join(dir, REJECTED_FILE)} is not valid JSON`);
    await writeFile(join(dir, REJECTED_FILE), JSON.stringify([{ serverId: "weather" }]));
    await expect(readRejected(dir)).rejects.toThrow("is not a valid rejection list");
  });

  it("refuses to write an invalid entry", async () => {
    const bad = [{ ...addRejection([], changes[0]!, now)[0]!, composite: "nope" }] as Rejection[];
    await expect(writeRejected(dir, bad)).rejects.toThrow("refusing to write an invalid rejection list");
  });
});

describe("addRejection and findRejection", () => {
  it("records the served definition of a change", () => {
    const [forecast] = changes;
    expect(addRejection([], forecast!, now)).toEqual([
      {
        serverId: "weather",
        toolName: "get_forecast",
        composite: forecast!.after.hashes.composite,
        tier: 3,
        changeId: forecast!.id,
        rejectedAt: now.toISOString(),
      },
    ]);
  });

  it("replaces an earlier rejection of the same definition and keeps the others", () => {
    const first = addRejection(addRejection([], changes[0]!, now), changes[1]!, now);
    const again = addRejection(first, { ...changes[0]!, id: "chg_again" }, new Date("2026-10-30T00:00:00.000Z"));
    expect(again.map((r) => r.changeId)).toEqual([changes[1]!.id, "chg_again"]);
  });

  it("keeps only the newest MAX_REJECTIONS", () => {
    let list: Rejection[] = [];
    for (let i = 0; i <= MAX_REJECTIONS; i++) list = addRejection(list, { ...changes[0]!, toolName: `tool_${i}`, id: `chg_${i}` }, now);
    expect(list).toHaveLength(MAX_REJECTIONS);
    expect(list[0]!.toolName).toBe("tool_1");
  });

  it("finds a rejection only for the exact server, tool and definition", () => {
    const [forecast] = changes;
    const list = addRejection([], forecast!, now);
    const composite = forecast!.after.hashes.composite;
    expect(findRejection(list, "weather", "get_forecast", composite)?.changeId).toBe(forecast!.id);
    expect(findRejection(list, "weather", "get_forecast", "0".repeat(64))).toBeUndefined();
    expect(findRejection(list, "other", "get_forecast", composite)).toBeUndefined();
    expect(findRejection(list, "weather", "get_alerts", composite)).toBeUndefined();
  });
});
