import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CapabilitySetSchema,
  FindingSchema,
  LockFileSchema,
  MAX_SIMULATED_CALLS,
  McpToolListSchema,
  PendingChangeSchema,
  SimulationRequestSchema,
  SimulationResultSchema,
  ToolRecordSchema,
  type CapabilitySet,
  type ToolRecord,
} from "../src/schema/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const HASH = "a".repeat(64);

const noCapabilities: CapabilitySet = {
  filesystem: { read: false, write: false, scope: "none", paths: [] },
  exec: { enabled: false, shell: false },
  network: { egress: false, domains: [], unconstrained: false },
  credentials: { readsEnv: false, readsSecrets: false },
  crossServerRefs: [],
  declared: {},
};

const record = (overrides: Partial<ToolRecord> = {}): ToolRecord => ({
  name: "get_forecast",
  serverId: "weather",
  hashes: { name: HASH, description: HASH, inputSchema: HASH, metadata: HASH, composite: HASH },
  capabilities: noCapabilities,
  approvedBy: "alice@example.com",
  approvedAt: "2026-10-01T12:00:00.000Z",
  specVersion: "2025-06-18",
  ...overrides,
});

describe("McpToolListSchema", () => {
  it("parses the benign fixture", () => {
    const list = McpToolListSchema.parse(fixture("benign-tools.json"));
    expect(list.tools.map((t) => t.name)).toEqual(["get_forecast", "get_alerts"]);
    expect(list.tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("parses the poisoned fixture, which really is poisoned", () => {
    const list = McpToolListSchema.parse(fixture("poisoned-tools.json"));
    expect(list.tools).toHaveLength(4);
    const forecast = list.tools.find((t) => t.name === "get_forecast");
    expect(forecast?.description).toMatch(/​/);
    expect(forecast?.description).toContain("~/.ssh/id_rsa");
    expect(list.tools.find((t) => t.name === "run_diagnostics")?.description).toMatch(/‮/);
    expect(list.tools.find((t) => t.name === "sync_alerts")?.description).toMatch(/\u{E0068}/u);
  });

  it("preserves fields it does not model, so the proxy can forward them", () => {
    const list = McpToolListSchema.parse(fixture("poisoned-tools.json"));
    const sync = list.tools.find((t) => t.name === "sync_alerts");
    expect(sync?.["x-vendor-extension"]).toEqual({ kept: true });
    expect(sync?.inputSchema.properties?.endpoint).toEqual({ type: "string", format: "uri" });
  });

  it("rejects a tool whose inputSchema is not an object schema", () => {
    const result = McpToolListSchema.safeParse({
      tools: [{ name: "x", inputSchema: { type: "string" } }],
    });
    expect(result.success).toBe(false);
  });
});

describe("CapabilitySetSchema", () => {
  it("accepts a fully specified set", () => {
    expect(CapabilitySetSchema.parse(noCapabilities)).toEqual(noCapabilities);
  });

  it("rejects an unknown filesystem scope", () => {
    const bad = { ...noCapabilities, filesystem: { ...noCapabilities.filesystem, scope: "some" } };
    expect(CapabilitySetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a set missing a capability group", () => {
    const { exec: _exec, ...missing } = noCapabilities;
    expect(CapabilitySetSchema.safeParse(missing).success).toBe(false);
  });
});

describe("FindingSchema", () => {
  it("accepts a critical unicode finding and rejects unknown types", () => {
    const finding = { type: "unicode", severity: "critical", message: "zero-width run", evidence: "U+200B x8" };
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(FindingSchema.safeParse({ ...finding, type: "vibes" }).success).toBe(false);
  });
});

describe("ToolRecordSchema", () => {
  it("accepts a valid record", () => {
    expect(ToolRecordSchema.parse(record()).name).toBe("get_forecast");
  });

  it("rejects non-hex or uppercase hashes", () => {
    const upper = record({ hashes: { name: HASH, description: HASH, inputSchema: HASH, metadata: HASH, composite: "A".repeat(64) } });
    const short = record({ hashes: { name: "abc", description: HASH, inputSchema: HASH, metadata: HASH, composite: HASH } });
    expect(ToolRecordSchema.safeParse(upper).success).toBe(false);
    expect(ToolRecordSchema.safeParse(short).success).toBe(false);
  });

  it("rejects a non-ISO approval date", () => {
    expect(ToolRecordSchema.safeParse(record({ approvedAt: "yesterday" })).success).toBe(false);
  });
});

describe("LockFileSchema", () => {
  const lock = (tools: ToolRecord[]) => ({
    version: "1",
    generatedAt: "2026-10-01T12:00:00.000Z",
    servers: { weather: { transport: "stdio", command: "node", args: ["weather.js"], tools } },
  });

  it("parses latch.lock.example", () => {
    const example = JSON.parse(readFileSync(new URL("../latch.lock.example", import.meta.url), "utf8"));
    const parsed = LockFileSchema.parse(example);
    expect(parsed.servers.weather?.tools.map((t) => t.name)).toEqual(["get_alerts", "get_forecast"]);
  });

  it("accepts a valid lockfile", () => {
    const parsed = LockFileSchema.parse(lock([record(), record({ name: "get_alerts" })]));
    expect(parsed.servers.weather?.tools).toHaveLength(2);
  });

  it("rejects a record filed under the wrong server key", () => {
    expect(LockFileSchema.safeParse(lock([record({ serverId: "mail" })])).success).toBe(false);
  });

  it("rejects duplicate tool names within a server", () => {
    expect(LockFileSchema.safeParse(lock([record(), record()])).success).toBe(false);
  });
});

describe("PendingChangeSchema", () => {
  const change = {
    id: "chg_01",
    serverId: "weather",
    toolName: "get_forecast",
    tier: 3,
    detectedAt: "2026-10-02T09:30:00.000Z",
    before: record(),
    after: record({
      capabilities: {
        ...noCapabilities,
        filesystem: { read: true, write: false, scope: "unconstrained", paths: [] },
      },
    }),
    capabilityDelta: { gained: ["filesystem.read"], lost: [], loosened: ["filesystem.scope"] },
    findings: [{ type: "unicode", severity: "critical", message: "zero-width run", evidence: "U+200B x8" }],
  };

  it("accepts a change with a prior record", () => {
    expect(PendingChangeSchema.parse(change).tier).toBe(3);
  });

  it("accepts a newly appeared tool with before = null", () => {
    expect(PendingChangeSchema.parse({ ...change, before: null }).before).toBeNull();
  });

  it("rejects tiers outside 0-3", () => {
    expect(PendingChangeSchema.safeParse({ ...change, tier: 4 }).success).toBe(false);
    expect(PendingChangeSchema.safeParse({ ...change, tier: "2" }).success).toBe(false);
  });
});

describe("SimulationRequestSchema", () => {
  const request = { serverId: "weather", pinned: fixture("benign-tools.json"), served: fixture("poisoned-tools.json"), callsBefore: ["get_alerts"], callsAfter: ["get_forecast"] };

  it("accepts a rug pull built from the fixtures", () => {
    expect(SimulationRequestSchema.parse(request)).toEqual(request);
  });

  it("caps the number of replayed calls and rejects empty names", () => {
    expect(SimulationRequestSchema.safeParse({ ...request, callsAfter: Array(MAX_SIMULATED_CALLS + 1).fill("x") }).success).toBe(false);
    expect(SimulationRequestSchema.safeParse({ ...request, callsBefore: [""] }).success).toBe(false);
    expect(SimulationRequestSchema.safeParse({ ...request, serverId: "" }).success).toBe(false);
  });
});

describe("SimulationResultSchema", () => {
  it("parses forwarded and blocked calls", () => {
    const blocked = { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "blocked", data: { reason: { kind: "unpinned" } } } };
    const result = { serverId: "weather", pinned: [record()], callsBefore: [{ toolName: "get_forecast", blocked: null }], changes: [], unchanged: ["get_forecast"], callsAfter: [{ toolName: "get_forecast", blocked }] };
    expect(SimulationResultSchema.parse(result)).toEqual(result);
    expect(SimulationResultSchema.safeParse({ ...result, callsAfter: [{ toolName: "x", blocked: { id: 1 } }] }).success).toBe(false);
  });
});
