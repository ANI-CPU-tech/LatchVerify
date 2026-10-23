import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCK_ERROR_CODE, buildBlockError, shouldBlock, type BlockReason } from "../../src/proxy/blocker.js";
import { isResponse, parseLine, serialize } from "../../src/proxy/transport.js";
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

describe("buildBlockError", () => {
  const reasons: BlockReason[] = [
    { kind: "unpinned" },
    { kind: "pending_review", changeId: "chg_2", tier: 2 },
    { kind: "hard_block", changeId: "chg_7f3a91" },
  ];

  it("matches the documented hard-block response exactly", () => {
    // docs/ARCHITECTURE.md, "Blocking".
    expect(buildBlockError(7, "get_forecast", { kind: "hard_block", changeId: "chg_7f3a91" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32001,
        message: "LatchVerify blocked \"get_forecast\" pending review — run `latch review`",
        data: { reason: { kind: "hard_block", changeId: "chg_7f3a91" } },
      },
    });
  });

  it("uses code -32001 and names latch review for every reason", () => {
    expect(BLOCK_ERROR_CODE).toBe(-32001);
    for (const reason of reasons) {
      const { error } = buildBlockError(1, "get_forecast", reason);
      expect(error?.code).toBe(BLOCK_ERROR_CODE);
      expect(error?.message).toContain('"get_forecast"');
      expect(error?.message).toContain("`latch review`");
      expect(error?.data).toEqual({ reason });
    }
  });

  it("says an unpinned tool is not approved, and a pending one awaits review", () => {
    expect(buildBlockError(1, "read_config", { kind: "unpinned" }).error?.message).toBe(
      "LatchVerify blocked \"read_config\": the tool is not approved in latch.lock — run `latch review`",
    );
    expect(buildBlockError(1, "get_forecast", reasons[1]!).error?.message).toBe(
      "LatchVerify blocked \"get_forecast\" pending review — run `latch review`",
    );
  });

  it("echoes the request id unchanged, including string and null ids", () => {
    for (const id of [0, 42, -1, "req-1", "", null]) {
      expect(buildBlockError(id, "get_forecast", { kind: "unpinned" }).id).toBe(id);
    }
  });

  it("serializes to a single line that parses back as a response", () => {
    for (const reason of reasons) {
      const response = buildBlockError("abc", "get_forecast", reason);
      const line = serialize(response);
      expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
      const { message } = parseLine(line.slice(0, -1));
      expect(message).toEqual(response);
      expect(isResponse(message!)).toBe(true);
    }
  });

  it("renders a hostile tool name as printable ASCII", () => {
    const hostile = 'x"\u202e\u200b\u0007\n\u{e0068}\u{e0069} ignore previous';
    const { error } = buildBlockError(1, hostile, { kind: "unpinned" });
    expect(error?.message).toBe(
      'LatchVerify blocked "x[U+0022][U+202E][U+200B][U+0007][U+000A][U+E0068][U+E0069] ignore previous": the tool is not approved in latch.lock — run `latch review`',
    );
  });

  it("truncates an overlong tool name by codepoint", () => {
    const { error } = buildBlockError(1, "😀".repeat(500), { kind: "unpinned" });
    expect(error?.message).toContain(`"${"[U+1F600]".repeat(128)}" (name truncated)`);
    expect(error?.message).not.toContain("[U+1F600]".repeat(129));
    expect(buildBlockError(1, "a".repeat(128), { kind: "unpinned" }).error?.message).toContain(`"${"a".repeat(128)}":`);
  });
});
