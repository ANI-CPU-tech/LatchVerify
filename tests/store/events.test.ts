import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_FILE, appendEvent, readEvents, type LatchEvent } from "../../src/store/events.js";

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

  it("starts on a fresh line when the log ends in a torn write", async () => {
    await writeFile(join(dir, EVENTS_FILE), `${JSON.stringify(allKinds[0])}\n{"kind":"list_cha`);
    await appendEvent(dir, allKinds[1]!);
    expect(await logLines(dir)).toEqual([JSON.stringify(allKinds[0]), '{"kind":"list_cha', JSON.stringify(allKinds[1])]);
    expect(await readEvents(dir)).toEqual([allKinds[0], allKinds[1]]);
  });

  it("does not add a blank line to a log that ends cleanly or is empty", async () => {
    await writeFile(join(dir, EVENTS_FILE), "");
    await appendEvent(dir, allKinds[0]!);
    await appendEvent(dir, allKinds[1]!);
    expect(await readFile(join(dir, EVENTS_FILE), "utf8")).toBe(`${JSON.stringify(allKinds[0])}\n${JSON.stringify(allKinds[1])}\n`);
  });

  it("keeps a client-supplied tool name on one line, whatever it contains", async () => {
    const toolName = 'x"\n{"kind":"approved"}\r\u2028\u0000';
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

describe("readEvents", () => {
  const listed = (n: number): LatchEvent => ({ kind: "tools_listed", at, serverId: "weather", toolCount: n });

  it("returns an empty list when the log or the state directory is missing", async () => {
    expect(await readEvents(dir)).toEqual([]);
    expect(await readEvents(join(dir, "missing"), 10)).toEqual([]);
  });

  it("reads back every appended event, oldest first", async () => {
    for (const event of allKinds) await appendEvent(dir, event);
    expect(await readEvents(dir)).toEqual(allKinds);
  });

  it("skips malformed lines instead of throwing", async () => {
    const lines = [
      JSON.stringify(allKinds[0]),
      "garbage",
      "",
      "   ",
      "{",
      "null",
      "[]",
      '"text"',
      JSON.stringify({ kind: "future_kind", at, serverId: "weather" }),
      JSON.stringify({ ...allKinds[1], at: "not a date" }),
      JSON.stringify(allKinds[1]),
      '{"kind":"list_changed","at":"2026-10-21T09:0', // torn final write
    ];
    await writeFile(join(dir, EVENTS_FILE), lines.join("\n"));
    expect(await readEvents(dir)).toEqual([allKinds[0], allKinds[1]]);
  });

  it("reads lines written with CRLF endings", async () => {
    await writeFile(join(dir, EVENTS_FILE), `${JSON.stringify(allKinds[0])}\r\n${JSON.stringify(allKinds[1])}\r\n`);
    expect(await readEvents(dir)).toEqual([allKinds[0], allKinds[1]]);
  });

  it("drops fields LatchEvent does not define", async () => {
    await writeFile(join(dir, EVENTS_FILE), `${JSON.stringify({ ...allKinds[1], extra: true })}\n`);
    expect(await readEvents(dir)).toEqual([allKinds[1]]);
  });

  it("returns the newest `limit` events, oldest first", async () => {
    for (let i = 0; i < 5; i++) await appendEvent(dir, listed(i));
    expect(await readEvents(dir, 2)).toEqual([listed(3), listed(4)]);
    expect(await readEvents(dir, 5)).toEqual([0, 1, 2, 3, 4].map(listed));
    expect(await readEvents(dir, 100)).toEqual([0, 1, 2, 3, 4].map(listed));
    expect(await readEvents(dir, 0)).toEqual([]);
  });

  it("counts only valid events toward the limit", async () => {
    await writeFile(join(dir, EVENTS_FILE), [JSON.stringify(listed(0)), JSON.stringify(listed(1)), "garbage", "garbage"].join("\n"));
    expect(await readEvents(dir, 2)).toEqual([listed(0), listed(1)]);
  });

  it("keeps the newest events of a long log", async () => {
    const total = 10_000;
    await writeFile(join(dir, EVENTS_FILE), Array.from({ length: total }, (_, i) => `${JSON.stringify(listed(i))}\n`).join(""));
    expect(await readEvents(dir, 3)).toEqual([total - 3, total - 2, total - 1].map(listed));
    expect(await readEvents(dir, 1500)).toEqual(Array.from({ length: 1500 }, (_, i) => listed(total - 1500 + i)));
    expect(await readEvents(dir)).toHaveLength(total);
  });

  it("rejects a limit that is not a non-negative integer", async () => {
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readEvents(dir, limit), String(limit)).rejects.toThrow(RangeError);
    }
  });

  it("surfaces read errors other than a missing log", async () => {
    await writeFile(join(dir, "file"), "");
    await expect(readEvents(join(dir, "file"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("keeps the event before a garbage line (task Verify scenario)", async () => {
    await appendEvent(dir, allKinds[1]!);
    expect(await readEvents(dir)).toEqual([allKinds[1]]);
    await appendFile(join(dir, EVENTS_FILE), "garbage\n");
    expect(await readEvents(dir)).toEqual([allKinds[1]]);
    expect(await readdir(dir)).toEqual([EVENTS_FILE]);
  });
});
