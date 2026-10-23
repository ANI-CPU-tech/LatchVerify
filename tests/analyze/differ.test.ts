import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashTool } from "../../src/analyze/hash.js";
import { emptyCapabilitySet, extractCapabilities } from "../../src/analyze/capabilities.js";
import { anySegmentChanged, diffCapabilities, diffHashes } from "../../src/analyze/differ.js";
import { CapabilityDeltaSchema, McpToolListSchema, type CapabilitySet, type McpTool } from "../../src/schema/index.js";

const fixtureTools = (name: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

const fixtureTool = (file: string, name: string): McpTool => fixtureTools(file).find((t) => t.name === name)!;

describe("diffHashes", () => {
  const forecast = fixtureTool("benign-tools.json", "get_forecast");
  const hashesOf = (overrides: Partial<McpTool>) => hashTool({ ...structuredClone(forecast), ...overrides });

  it("reports no change for identical definitions", () => {
    const segments = diffHashes(hashTool(forecast), hashTool(structuredClone(forecast)));
    expect(segments).toEqual({ name: false, description: false, inputSchema: false });
    expect(anySegmentChanged(segments)).toBe(false);
  });

  it("reports exactly the segment that changed", () => {
    const base = hashTool(forecast);
    expect(diffHashes(base, hashesOf({ name: "get_forecast_v2" }))).toEqual({ name: true, description: false, inputSchema: false });
    expect(diffHashes(base, hashesOf({ description: "Fetch the forecast." }))).toEqual({ name: false, description: true, inputSchema: false });
    expect(diffHashes(base, hashesOf({ inputSchema: { type: "object", properties: {} } }))).toEqual({
      name: false,
      description: false,
      inputSchema: true,
    });
  });

  it("flags the poisoned get_forecast as a description and schema change", () => {
    const segments = diffHashes(hashTool(forecast), hashTool(fixtureTool("poisoned-tools.json", "get_forecast")));
    expect(segments).toEqual({ name: false, description: true, inputSchema: true });
    expect(anySegmentChanged(segments)).toBe(true);
  });

  it("is symmetric", () => {
    const a = hashTool(forecast);
    const b = hashTool(fixtureTool("poisoned-tools.json", "get_forecast"));
    expect(diffHashes(a, b)).toEqual(diffHashes(b, a));
  });
});

/** The empty set with `mutate` applied. */
const caps = (mutate: (c: CapabilitySet) => void = () => {}): CapabilitySet => {
  const c = emptyCapabilitySet();
  mutate(c);
  return c;
};

const capsOf = (file: string, name: string) => extractCapabilities(fixtureTool(file, name), []).capabilities;

describe("diffCapabilities", () => {
  it("returns an empty delta for identical sets", () => {
    expect(diffCapabilities(capsOf("benign-tools.json", "get_forecast"), capsOf("benign-tools.json", "get_forecast"))).toEqual({
      gained: [],
      lost: [],
      loosened: [],
    });
  });

  it("puts every capability of a new tool in gained, and its widths in loosened", () => {
    const after = caps((c) => {
      c.filesystem = { read: true, write: true, scope: "unconstrained", paths: [] };
      c.exec = { enabled: true, shell: true };
      c.network = { egress: true, domains: [], unconstrained: true };
      c.credentials = { readsEnv: true, readsSecrets: true };
      c.crossServerRefs = ["send_email"];
    });
    expect(diffCapabilities(null, after)).toEqual({
      gained: [
        "credentials.readsEnv",
        "credentials.readsSecrets",
        "crossServerRefs:send_email",
        "exec.enabled",
        "exec.shell",
        "filesystem.read",
        "filesystem.write",
        "network.egress",
      ],
      lost: [],
      loosened: ["filesystem.scope", "network.unconstrained"],
    });
  });

  it("treats a new tool with no capabilities as an empty delta", () => {
    expect(diffCapabilities(null, emptyCapabilitySet())).toEqual({ gained: [], lost: [], loosened: [] });
  });

  it("reports capabilities that disappear as lost", () => {
    const before = caps((c) => {
      c.exec = { enabled: true, shell: true };
      c.crossServerRefs = ["a", "b"];
    });
    const after = caps((c) => {
      c.exec = { enabled: true, shell: false };
      c.crossServerRefs = ["b"];
    });
    expect(diffCapabilities(before, after)).toEqual({ gained: [], lost: ["crossServerRefs:a", "exec.shell"], loosened: [] });
  });

  it("orders filesystem scope none < constrained < unconstrained", () => {
    const at = (scope: CapabilitySet["filesystem"]["scope"]) =>
      caps((c) => {
        c.filesystem = { read: scope !== "none", write: false, scope, paths: scope === "constrained" ? ["/a"] : [] };
      });
    expect(diffCapabilities(at("constrained"), at("unconstrained")).loosened).toEqual(["filesystem.scope"]);
    expect(diffCapabilities(at("unconstrained"), at("constrained"))).toEqual({ gained: [], lost: ["filesystem.scope"], loosened: [] });
    expect(diffCapabilities(at("none"), at("constrained"))).toEqual({ gained: ["filesystem.read"], lost: [], loosened: ["filesystem.scope"] });
  });

  it("reports a URL parameter becoming free-form as loosened, and the reverse as lost", () => {
    const pinned = caps((c) => {
      c.network = { egress: true, domains: ["api.x.com"], unconstrained: false };
    });
    const open = caps((c) => {
      c.network = { egress: true, domains: [], unconstrained: true };
    });
    expect(diffCapabilities(pinned, open)).toEqual({ gained: [], lost: [], loosened: ["network.unconstrained"] });
    expect(diffCapabilities(open, pinned)).toEqual({ gained: [], lost: ["network.unconstrained"], loosened: [] });
  });

  it("ignores declared annotations", () => {
    const claimed = caps((c) => {
      c.declared = { readOnlyHint: true };
    });
    expect(diffCapabilities(emptyCapabilitySet(), claimed)).toEqual({ gained: [], lost: [], loosened: [] });
  });

  it("captures the gains of every poisoned tool against its benign counterpart or nothing", () => {
    expect(diffCapabilities(capsOf("benign-tools.json", "get_forecast"), capsOf("poisoned-tools.json", "get_forecast"))).toEqual({
      gained: [],
      lost: [],
      loosened: [],
    });
    expect(diffCapabilities(null, capsOf("poisoned-tools.json", "read_config"))).toEqual({
      gained: ["filesystem.read"],
      lost: [],
      loosened: ["filesystem.scope"],
    });
    expect(diffCapabilities(null, capsOf("poisoned-tools.json", "run_diagnostics")).gained).toEqual(["exec.enabled", "exec.shell"]);
    expect(diffCapabilities(null, extractCapabilities(fixtureTool("poisoned-tools.json", "sync_alerts"), ["send_email"]).capabilities)).toEqual({
      gained: ["crossServerRefs:send_email", "network.egress"],
      lost: [],
      loosened: ["network.unconstrained"],
    });
  });

  it("returns schema-valid, sorted, duplicate-free lists and does not mutate its inputs", () => {
    const before = capsOf("poisoned-tools.json", "sync_alerts");
    const after = capsOf("poisoned-tools.json", "read_config");
    const snapshot = structuredClone([before, after]);
    const delta = diffCapabilities(before, after);
    expect(CapabilityDeltaSchema.parse(delta)).toEqual(delta);
    for (const list of Object.values(delta)) expect(list).toEqual([...new Set(list)].sort());
    expect([before, after]).toEqual(snapshot);
  });
});
