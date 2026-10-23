import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LockFileSchema, type LatchEvent, type PendingChange } from "../../src/schema/index.js";
import { VERIFY_EXIT } from "../../src/commands/verify.js";
import { VERIFY_EXIT_CODES } from "../../web/src/lib/ci.js";
import {
  EVENT_KINDS,
  approvedToolCount,
  capabilityChips,
  capabilityLabel,
  capabilityRows,
  describeEvent,
  explainChange,
  isHighReach,
  lastApproval,
  relativeTime,
  serverSummaries,
} from "../../web/src/lib/format.js";
import { mockReviewItems } from "../../web/src/lib/mock.js";
import { href, parseRoute } from "../../web/src/lib/router.js";

const lock = LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")));
const [forecast, sync, alerts] = mockReviewItems.map((item) => item.change) as [PendingChange, PendingChange, PendingChange];
const at = "2026-10-23T09:00:00.000Z";

describe("capabilityLabel", () => {
  it("names every key the differ reports in plain words", () => {
    expect(capabilityLabel("filesystem.read")).toBe("read files");
    expect(capabilityLabel("exec.shell")).toBe("run shell commands");
    expect(capabilityLabel("network.unconstrained")).toBe("reach any URL");
    expect(capabilityLabel("network.domains:evil.example")).toBe("reach evil.example");
    expect(capabilityLabel("filesystem.paths:/etc")).toBe("access /etc");
    expect(capabilityLabel("crossServerRefs:send_email")).toBe("reference tool send_email");
    expect(capabilityLabel("future.key")).toBe("future.key");
  });
});

describe("explainChange", () => {
  it("leads with what a poisoned tool can now do, and says it is hard-blocked", () => {
    const { headline, details } = explainChange(forecast);
    expect(headline).toBe("It can now read files and reach any file path.");
    expect(details.join(" ")).toContain("changed since it was approved");
    expect(details.join(" ")).toContain("4 findings, 2 critical");
    expect(details.join(" ")).toContain("hard-blocked calls to it until you approve");
  });

  it("calls out a new tool and a text-only change", () => {
    expect(explainChange(sync).details[0]).toBe("This tool is new and was never approved.");
    expect(explainChange(alerts).headline).toBe("Its capabilities did not change.");
    expect(explainChange(alerts).details.join(" ")).toContain("auto-passed");
  });

  it("reports narrowing", () => {
    const narrowed = { ...alerts, tier: 1 as const, capabilityDelta: { gained: [], lost: ["network.egress"], loosened: [] } };
    expect(explainChange(narrowed).headline).toBe("Its capabilities only narrowed.");
    expect(explainChange(narrowed).details).toContain("It can no longer make network requests.");
  });
});

describe("capability views", () => {
  it("compares approved and current capabilities row by row", () => {
    const rows = capabilityRows(forecast.before!.capabilities, forecast.after.capabilities);
    expect(rows.find((row) => row.group === "Filesystem")).toEqual({ group: "Filesystem", before: "no access", after: "read (unconstrained)", changed: true });
    expect(rows.find((row) => row.group === "Network")).toMatchObject({ before: "api.weather.gov", changed: false });
    const fresh = capabilityRows(null, sync.after.capabilities);
    expect(fresh.every((row) => row.before === "not approved")).toBe(true);
    // A new tool: only groups where it has something are highlighted.
    expect(fresh.filter((row) => row.changed).map((row) => row.group)).toEqual(["Network"]);
  });

  it("summarizes a tool as chips and flags wide reach", () => {
    expect(capabilityChips(forecast.before!.capabilities)).toEqual(["network: api.weather.gov"]);
    expect(capabilityChips(forecast.after.capabilities)).toContain("files: read (unconstrained)");
    expect(isHighReach(forecast.before!.capabilities)).toBe(false);
    expect(isHighReach(forecast.after.capabilities)).toBe(true);
    expect(isHighReach(sync.after.capabilities)).toBe(true);
  });
});

describe("describeEvent", () => {
  const events: LatchEvent[] = [
    { kind: "tools_listed", at, serverId: "weather", toolCount: 1 },
    { kind: "list_changed", at, serverId: "weather" },
    { kind: "change_detected", at, serverId: "weather", toolName: "get_forecast", tier: 3, changeId: "c" },
    { kind: "auto_passed", at, serverId: "weather", toolName: "get_alerts", tier: 0 },
    { kind: "call_blocked", at, serverId: "weather", toolName: "get_forecast", reason: "hard-blocked pending review" },
    { kind: "approved", at, serverId: "weather", toolName: "x", changeId: "c", approvedBy: "alice@example.com" },
    { kind: "rejected", at, serverId: "weather", toolName: "x", changeId: "c" },
  ];

  it("covers every event kind", () => {
    expect(events.map((event) => event.kind).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it("describes each event with a tone", () => {
    expect(describeEvent(events[0]!)).toEqual({ title: "Tool list checked", subject: "weather", detail: "1 tool listed and analyzed", tone: "info" });
    expect(describeEvent(events[2]!)).toMatchObject({ subject: "weather / get_forecast", detail: "Tier 3: hard-blocked", tone: "destructive" });
    expect(describeEvent(events[4]!)).toMatchObject({ detail: "hard-blocked pending review", tone: "destructive" });
    expect(describeEvent(events[5]!)).toMatchObject({ detail: "Approved by alice@example.com", tone: "success" });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  it.each([
    ["2026-10-23T11:59:30.000Z", "just now"],
    ["2026-10-23T11:55:00.000Z", "5 min ago"],
    ["2026-10-23T09:00:00.000Z", "3 h ago"],
    ["2026-10-22T12:00:00.000Z", "1 day ago"],
    ["2026-10-20T12:00:00.000Z", "3 days ago"],
    ["2026-01-01T00:00:00.000Z", "2026-01-01"],
    ["2026-10-24T00:00:00.000Z", "2026-10-24"],
    ["not a date", "not a date"],
  ])("%s is %s", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe("serverSummaries", () => {
  it("summarizes pinned servers from latch.lock, the queue and the log", () => {
    const events: LatchEvent[] = [
      { kind: "tools_listed", at: "2026-10-23T08:00:00.000Z", serverId: "weather", toolCount: 2 },
      { kind: "tools_listed", at, serverId: "weather", toolCount: 3 },
      { kind: "call_blocked", at, serverId: "weather", toolName: "get_forecast", reason: "r" },
    ];
    const [weather] = serverSummaries(lock, [forecast, sync], events);
    expect(weather).toMatchObject({
      id: "weather",
      pinned: true,
      transport: "stdio",
      approvedTools: lock.servers.weather!.tools.length,
      pending: 2,
      highestPendingTier: 3,
      firstPendingId: forecast.id,
      lastListed: { at, toolCount: 3 },
      blockedCalls: 1,
      status: { label: "High-risk change", tone: "destructive" },
    });
    expect(weather!.command).toContain("demo/weather-server.ts");
  });

  it("says a server with nothing pending matches latch.lock, and lists unpinned servers last", () => {
    const summaries = serverSummaries(lock, [], [{ kind: "list_changed", at, serverId: "aaa-unpinned" }]);
    expect(summaries.map((s) => s.id)).toEqual([...Object.keys(lock.servers).sort(), "aaa-unpinned"]);
    expect(summaries[0]!.status).toEqual({ label: "Matches latch.lock", tone: "success" });
    expect(summaries.at(-1)).toMatchObject({ pinned: false, transport: null, command: null, status: { label: "Not pinned" } });
  });

  it("quotes arguments that need it", () => {
    const custom = { ...lock, servers: { s: { transport: "stdio" as const, command: "node", args: ["my server.js", "--x=1"], tools: [] } } };
    expect(serverSummaries(custom, [], [])[0]!.command).toBe('node "my server.js" --x=1');
  });

  it("counts tools and finds the latest approval", () => {
    expect(approvedToolCount(lock)).toBe(Object.values(lock.servers).reduce((n, s) => n + s.tools.length, 0));
    expect(lastApproval(lock)).toMatchObject({ tool: expect.stringContaining("weather / ") });
    expect(lastApproval({ ...lock, servers: {} })).toBeNull();
  });
});

describe("router", () => {
  it.each([
    ["", { page: "overview" }],
    ["#/", { page: "overview" }],
    ["#/servers", { page: "servers" }],
    ["#/review", { page: "review", id: null }],
    ["#/review/chg_1", { page: "review", id: "chg_1" }],
    ["#/tools/my%20server", { page: "tools", server: "my server" }],
    ["#/audit", { page: "audit" }],
    ["#/git-ci", { page: "ci" }],
    ["#/settings", { page: "settings" }],
    ["#/nope", { page: "not-found", path: "/nope" }],
    ["#/settings/extra", { page: "not-found", path: "/settings/extra" }],
    ["#/review/a/b", { page: "not-found", path: "/review/a/b" }],
    ["#/review/%E0%A4%A", { page: "review", id: null }],
  ])("parses %s", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it("round-trips every route through href", () => {
    for (const route of [
      { page: "overview" },
      { page: "servers" },
      { page: "review", id: "chg/../x y" },
      { page: "review", id: null },
      { page: "tools", server: "weather" },
      { page: "audit" },
      { page: "ci" },
      { page: "settings" },
    ] as const) {
      expect(parseRoute(href(route))).toEqual(route);
    }
  });
});

describe("VERIFY_EXIT_CODES", () => {
  it("match latch verify's exit codes", () => {
    expect(Object.fromEntries(VERIFY_EXIT_CODES.map((row) => [row.status, row.code]))).toEqual({
      ok: VERIFY_EXIT.ok,
      drift: VERIFY_EXIT.drift,
      hard_block: VERIFY_EXIT.hardBlock,
      error: VERIFY_EXIT.error,
    });
  });
});
