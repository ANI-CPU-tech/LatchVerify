import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_FILE, appendEvent, type LatchEvent } from "../../src/store/events.js";

const at = "2026-10-21T09:00:00.000Z";

/** One event of every kind. */
const allKinds: LatchEvent[] = [
  { kind: "tools_listed", at, serverId: "weather", toolCount: 2 },
  { kind: "list_changed", at, serverId: "weather" },
  { kind: "change_detected", at, serverId: "weather", toolName: "get_forecast", tier: 3, changeId: "chg_7f3a91" },
  { kind: "auto_passed", at, serverId: "weather", toolName: "get_alerts", tier: 0 },
  { kind: "call_blocked", at, serverId: "weather", toolName: "get_forecast", reason: "hard_block" },
  { kind: "approved", at, serverId: "weather", toolName: "get_forecast", changeId: "chg_7f3a91", approvedBy: "dev@example.com" },
  { kind: "rejected", at, serverId: "weather", toolName: "get_forecast", changeId: "chg_7f3a91" },
];

const logLines = async (stateDir: string): Promise<string[]> => {
  const text = await readFile(join(stateDir, EVENTS_FILE), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n");
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-events-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("writes each event as one JSON line, in order", async () => {
    for (const event of allKinds) await appendEvent(dir, event);
    const lines = await logLines(dir);
    expect(lines).toEqual(allKinds.map((event) => JSON.stringify(event)));
  });

  it("creates a missing state directory", async () => {
    const nested = join(dir, "a", ".latch");
    await appendEvent(nested, allKinds[1]!);
    expect(await logLines(nested)).toEqual([JSON.stringify(allKinds[1])]);
  });

  it("appends to an existing log without rewriting it", async () => {
    await writeFile(join(dir, EVENTS_FILE), '{"kept":"as is"}\n');
    await appendEvent(dir, allKinds[0]!);
    expect(await logLines(dir)).toEqual(['{"kept":"as is"}', JSON.stringify(allKinds[0])]);
  });

  it("keeps a client-supplied tool name on one line, whatever it contains", async () => {
    const toolName = 'x"\n{"kind":"approved"}\r \u0000';
    await appendEvent(dir, { kind: "call_blocked", at, serverId: "weather", toolName, reason: "unpinned" });
    const lines = await logLines(dir);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ toolName });
  });

  it("logs an empty tool name rather than rejecting the event", async () => {
    await appendEvent(dir, { kind: "call_blocked", at, serverId: "weather", toolName: "", reason: "unpinned" });
    expect(await logLines(dir)).toHaveLength(1);
  });

  it("rejects an event that does not match LatchEvent, writing nothing", async () => {
    const bad = [
      { kind: "list_changed", at: "yesterday", serverId: "weather" },
      { kind: "list_changed", serverId: "weather" },
      { kind: "unknown", at },
      { kind: "change_detected", at, serverId: "weather", toolName: "t", tier: 4, changeId: "c" },
      { kind: "tools_listed", at, serverId: "weather", toolCount: -1 },
      { kind: "tools_listed", at, serverId: "weather", toolCount: 1.5 },
    ];
    for (const event of bad) {
      await expect(appendEvent(dir, event as LatchEvent), JSON.stringify(event)).rejects.toThrow(TypeError);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("never interleaves concurrent appends", async () => {
    const events = Array.from(
      { length: 200 },
      (_, i): LatchEvent => ({ kind: "call_blocked", at, serverId: "weather", toolName: `tool_${i}_${"x".repeat(i * 20)}`, reason: "unpinned" }),
    );
    await Promise.all(events.map((event) => appendEvent(dir, event)));
    const lines = await logLines(dir);
    expect(lines).toHaveLength(events.length);
    expect(new Set(lines)).toEqual(new Set(events.map((event) => JSON.stringify(event))));
  });
});
