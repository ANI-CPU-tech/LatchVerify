import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashTool } from "../../src/analyze/hash.js";
import { emptyCapabilitySet, extractCapabilities } from "../../src/analyze/capabilities.js";
import {
  MAX_DESCRIPTION_EDIT,
  anySegmentChanged,
  diffCapabilities,
  diffDescription,
  diffHashes,
  type DescriptionPart,
} from "../../src/analyze/differ.js";
import { CapabilityDeltaSchema, McpToolListSchema, type CapabilitySet, type McpTool } from "../../src/schema/index.js";

const fixtureTools = (name: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

const fixtureTool = (file: string, name: string): McpTool => fixtureTools(file).find((t) => t.name === name)!;

const description = (file: string, name: string): string => fixtureTool(file, name).description!;

describe("diffHashes", () => {
  const forecast = fixtureTool("benign-tools.json", "get_forecast");
  const hashesOf = (overrides: Partial<McpTool>) => hashTool({ ...structuredClone(forecast), ...overrides });

  it("reports no change for identical definitions", () => {
    const segments = diffHashes(hashTool(forecast), hashTool(structuredClone(forecast)));
    expect(segments).toEqual({ name: false, description: false, inputSchema: false, metadata: false });
    expect(anySegmentChanged(segments)).toBe(false);
  });

  it("reports exactly the segment that changed", () => {
    const base = hashTool(forecast);
    expect(diffHashes(base, hashesOf({ name: "get_forecast_v2" }))).toEqual({ name: true, description: false, inputSchema: false, metadata: false });
    expect(diffHashes(base, hashesOf({ description: "Fetch the forecast." }))).toEqual({ name: false, description: true, inputSchema: false, metadata: false });
    expect(diffHashes(base, hashesOf({ inputSchema: { type: "object", properties: {} } }))).toEqual({
      name: false,
      description: false,
      inputSchema: true,
      metadata: false,
    });
  });

  it("flags the poisoned get_forecast as a description and schema change", () => {
    const segments = diffHashes(hashTool(forecast), hashTool(fixtureTool("poisoned-tools.json", "get_forecast")));
    expect(segments).toEqual({ name: false, description: true, inputSchema: true, metadata: false });
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

describe("diffCapabilities: allow-lists", () => {
  const paths = (...list: string[]) =>
    caps((c) => {
      c.filesystem = { read: true, write: false, scope: "constrained", paths: list };
    });
  const domains = (...list: string[]) =>
    caps((c) => {
      c.network = { egress: true, domains: list, unconstrained: false };
    });

  it("reports paths added to a constrained list as loosened and removed ones as lost", () => {
    expect(diffCapabilities(paths("/data/*"), paths("/data/*", "/etc/*"))).toEqual({ gained: [], lost: [], loosened: ["filesystem.paths:/etc/*"] });
    expect(diffCapabilities(paths("/data/*", "/etc/*"), paths("/data/*"))).toEqual({ gained: [], lost: ["filesystem.paths:/etc/*"], loosened: [] });
    expect(diffCapabilities(paths("/a"), paths("/b"))).toEqual({ gained: [], lost: ["filesystem.paths:/a"], loosened: ["filesystem.paths:/b"] });
  });

  it("reports pinned domains the same way", () => {
    expect(diffCapabilities(domains("api.weather.gov"), domains("api.weather.gov", "evil.net"))).toEqual({
      gained: [],
      lost: [],
      loosened: ["network.domains:evil.net"],
    });
  });

  it("leaves list changes to the scope keys when one side is not constrained", () => {
    const anywhere = caps((c) => {
      c.filesystem = { read: true, write: false, scope: "unconstrained", paths: [] };
    });
    expect(diffCapabilities(paths("/data/*"), anywhere)).toEqual({ gained: [], lost: [], loosened: ["filesystem.scope"] });
    const anyUrl = caps((c) => {
      c.network = { egress: true, domains: [], unconstrained: true };
    });
    expect(diffCapabilities(domains("api.x.com"), anyUrl)).toEqual({ gained: [], lost: [], loosened: ["network.unconstrained"] });
    expect(diffCapabilities(emptyCapabilitySet(), domains("api.x.com"))).toEqual({ gained: ["network.egress"], lost: [], loosened: [] });
  });

  it("ignores list order", () => {
    expect(diffCapabilities(paths("/a", "/b"), paths("/b", "/a"))).toEqual({ gained: [], lost: [], loosened: [] });
  });
});

describe("diffDescription", () => {
  /** The two texts a diff must reproduce exactly. */
  const sides = (parts: DescriptionPart[]) => ({
    before: parts.filter((p) => !p.added).map((p) => p.value).join(""),
    after: parts.filter((p) => !p.removed).map((p) => p.value).join(""),
  });

  it("marks added and removed words and keeps the rest unchanged", () => {
    expect(diffDescription("Get active weather alerts for a US state.", "Get active weather alerts for a US state or territory.")).toEqual([
      { value: "Get active weather alerts for a US state", added: false, removed: false },
      { value: " or territory", added: true, removed: false },
      { value: ".", added: false, removed: false },
    ]);
    expect(diffDescription("Get the forecast now.", "Get the forecast.")).toEqual([
      { value: "Get the forecast", added: false, removed: false },
      { value: " now", added: false, removed: true },
      { value: ".", added: false, removed: false },
    ]);
  });

  it("reproduces both texts exactly, including whitespace and hidden characters", () => {
    const pairs: Array<[string, string]> = [
      ["Get the weather forecast for a location.", description("poisoned-tools.json", "get_forecast")],
      ["Run a diagnostic command.", description("poisoned-tools.json", "run_diagnostics")],
      ["line one\n  line two\ttab", "line one\nline  two\ttab changed"],
      ["", "new"],
      ["old", ""],
    ];
    for (const [before, after] of pairs) expect(sides(diffDescription(before, after))).toEqual({ before, after });
  });

  it("shows an inserted zero-width space inside the changed word", () => {
    const parts = diffDescription("Get the weather.", "Get the wea\u{200b}ther.");
    expect(parts.filter((p) => p.added).map((p) => p.value)).toEqual(["wea\u{200b}ther"]);
    expect(parts.filter((p) => p.removed).map((p) => p.value)).toEqual(["weather"]);
  });

  it("returns one unchanged part for identical text and nothing for two empty strings", () => {
    expect(diffDescription("same", "same")).toEqual([{ value: "same", added: false, removed: false }]);
    expect(diffDescription("", "")).toEqual([]);
  });

  it("handles a new or removed description", () => {
    expect(diffDescription("", "Sync alerts.")).toEqual([{ value: "Sync alerts.", added: true, removed: false }]);
    expect(diffDescription("Sync alerts.", "")).toEqual([{ value: "Sync alerts.", added: false, removed: true }]);
  });

  it(`falls back to a whole-text replacement when more than ${MAX_DESCRIPTION_EDIT} tokens change, quickly`, () => {
    const words = (seed: number) => Array.from({ length: 20_000 }, (_, i) => `w${(i * seed) % 9973}`).join(" ");
    const before = words(7);
    const after = words(13);
    const started = performance.now();
    const parts = diffDescription(before, after);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(parts).toEqual([
      { value: before, added: false, removed: true },
      { value: after, added: true, removed: false },
    ]);
  });

  it("still diffs a small edit inside a very long description", () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(" ");
    const after = before.replace("w5 ", "w5 inserted ");
    const parts = diffDescription(before, after);
    expect(parts.filter((p) => p.added).map((p) => p.value)).toEqual(["inserted "]);
    expect(sides(parts)).toEqual({ before, after });
  });
});
