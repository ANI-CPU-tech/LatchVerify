import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldBlock } from "../../src/proxy/blocker.js";
import {
  LockFileSchema,
  PendingChangeSchema,
  type LockFile,
  type PendingChange,
  type Tier,
  type ToolRecord,
} from "../../src/schema/index.js";

const exampleLock = (): LockFile =>
  LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")));

const emptyLock = (): LockFile => LockFileSchema.parse({ version: "1", generatedAt: "2026-10-20T14:02:11.000Z", servers: {} });

const pinned = (lock: LockFile, serverId: string, toolName: string): ToolRecord =>
  lock.servers[serverId]!.tools.find((tool) => tool.name === toolName)!;

/** Same record with a different composite hash, as a changed definition would have. */
const changedRecord = (record: ToolRecord, digit = "0"): ToolRecord => ({
  ...record,
  hashes: { ...record.hashes, composite: digit.repeat(64) },
});

/** A schema-valid pending change for a pinned example tool. */
function change(tier: Tier, options: { id?: string; serverId?: string; toolName?: string; before?: ToolRecord | null } = {}): PendingChange {
  const record = pinned(exampleLock(), "weather", "get_forecast");
  const serverId = options.serverId ?? "weather";
  const toolName = options.toolName ?? "get_forecast";
  const after = { ...changedRecord(record), serverId, name: toolName };
  return PendingChangeSchema.parse({
    id: options.id ?? `chg_tier${tier}`,
    serverId,
    toolName,
    tier,
    detectedAt: "2026-10-21T09:00:00.000Z",
    before: options.before === undefined ? record : options.before,
    after,
    capabilityDelta: { gained: [], lost: [], loosened: [] },
    findings: [],
  });
}

describe("shouldBlock", () => {
  it("allows a pinned tool with nothing pending", () => {
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [])).toEqual({ blocked: false });
    expect(shouldBlock("weather", "get_alerts", exampleLock(), [])).toEqual({ blocked: false });
  });

  it("blocks a tool that is not in the lockfile", () => {
    const unpinned = { blocked: true, reason: { kind: "unpinned" } };
    expect(shouldBlock("weather", "get_forecast", emptyLock(), [])).toEqual(unpinned);
    expect(shouldBlock("weather", "read_config", exampleLock(), [])).toEqual(unpinned);
    expect(shouldBlock("other", "get_forecast", exampleLock(), [])).toEqual(unpinned);
  });

  it("matches tool and server names exactly", () => {
    const unpinned = { blocked: true, reason: { kind: "unpinned" } };
    for (const name of ["Get_Forecast", "get_forecast ", " get_forecast", "get_forecas", "get_forecast​", ""]) {
      expect(shouldBlock("weather", name, exampleLock(), []), name).toEqual(unpinned);
    }
    expect(shouldBlock("Weather", "get_forecast", exampleLock(), [])).toEqual(unpinned);
  });

  it("does not resolve inherited object keys as servers or tools", () => {
    const unpinned = { blocked: true, reason: { kind: "unpinned" } };
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(shouldBlock(name, "get_forecast", exampleLock(), []), name).toEqual(unpinned);
      expect(shouldBlock("weather", name, exampleLock(), []), name).toEqual(unpinned);
    }
  });

  it("hard-blocks a pinned tool with a pending tier-3 change", () => {
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(3, { id: "chg_7f3a91" })])).toEqual({
      blocked: true,
      reason: { kind: "hard_block", changeId: "chg_7f3a91" },
    });
  });

  it("blocks a pinned tool with a pending tier-2 change for review", () => {
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(2, { id: "chg_2" })])).toEqual({
      blocked: true,
      reason: { kind: "pending_review", changeId: "chg_2", tier: 2 },
    });
  });

  it("lets tier-0 and tier-1 changes to a pinned tool auto-pass", () => {
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(0)])).toEqual({ blocked: false });
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(1)])).toEqual({ blocked: false });
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(0), change(1)])).toEqual({ blocked: false });
  });

  it("only applies a pending change to its own server and tool", () => {
    const pending = [change(3, { toolName: "get_alerts" }), change(3, { serverId: "other" })];
    expect(shouldBlock("weather", "get_forecast", exampleLock(), pending)).toEqual({ blocked: false });
    expect(shouldBlock("weather", "get_alerts", exampleLock(), pending)).toMatchObject({ reason: { kind: "hard_block" } });
  });

  it("reports the highest pending tier, whatever the queue order", () => {
    const tier3 = change(3, { id: "chg_3" });
    const tier2 = change(2, { id: "chg_2" });
    const expected = { blocked: true, reason: { kind: "hard_block", changeId: "chg_3" } };
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [tier2, tier3, change(0)])).toEqual(expected);
    expect(shouldBlock("weather", "get_forecast", exampleLock(), [change(1), tier3, tier2])).toEqual(expected);
  });

  it("reports the first change in queue order when tiers tie", () => {
    const pending = [change(2, { id: "chg_a" }), change(2, { id: "chg_b" })];
    expect(shouldBlock("weather", "get_forecast", exampleLock(), pending)).toMatchObject({ reason: { changeId: "chg_a" } });
  });

  it("reports a pending change to a new tool instead of plain unpinned", () => {
    const fresh = (tier: Tier) => change(tier, { id: `chg_new${tier}`, toolName: "read_config", before: null });
    expect(shouldBlock("weather", "read_config", exampleLock(), [fresh(3)])).toEqual({
      blocked: true,
      reason: { kind: "hard_block", changeId: "chg_new3" },
    });
    expect(shouldBlock("weather", "read_config", exampleLock(), [fresh(2)])).toEqual({
      blocked: true,
      reason: { kind: "pending_review", changeId: "chg_new2", tier: 2 },
    });
  });

  it("still blocks an unpinned tool whose pending change is tier 0 or 1", () => {
    for (const tier of [0, 1] as const) {
      const pending = [change(tier, { toolName: "read_config", before: null })];
      expect(shouldBlock("weather", "read_config", exampleLock(), pending)).toEqual({ blocked: true, reason: { kind: "unpinned" } });
    }
  });

  it("ignores a pending change that latch.lock already approves", () => {
    const lock = exampleLock();
    const stale = change(3, { id: "chg_approved" });
    lock.servers.weather!.tools = lock.servers.weather!.tools.map((tool) => (tool.name === "get_forecast" ? stale.after : tool));
    expect(shouldBlock("weather", "get_forecast", lock, [stale])).toEqual({ blocked: false });
  });

  it("ignores an approved new tool's change once the tool is pinned", () => {
    const lock = exampleLock();
    const stale = change(2, { toolName: "read_config", before: null });
    lock.servers.weather!.tools.push(stale.after);
    expect(shouldBlock("weather", "read_config", lock, [stale])).toEqual({ blocked: false });
  });

  it("still blocks a newer pending change next to an approved one", () => {
    const lock = exampleLock();
    const approved = change(3, { id: "chg_approved" });
    lock.servers.weather!.tools = lock.servers.weather!.tools.map((tool) => (tool.name === "get_forecast" ? approved.after : tool));
    const newer = { ...change(2, { id: "chg_newer" }), after: changedRecord(approved.after, "1") };
    expect(shouldBlock("weather", "get_forecast", lock, [approved, newer])).toEqual({
      blocked: true,
      reason: { kind: "pending_review", changeId: "chg_newer", tier: 2 },
    });
  });

  it("does not mutate its inputs", () => {
    const lock = exampleLock();
    const pending = [change(2), change(3)];
    const before = structuredClone({ lock, pending });
    shouldBlock("weather", "get_forecast", lock, pending);
    shouldBlock("weather", "missing", lock, pending);
    expect({ lock, pending }).toEqual(before);
  });
});
