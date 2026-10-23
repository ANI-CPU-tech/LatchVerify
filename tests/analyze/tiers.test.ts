import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCapabilities } from "../../src/analyze/capabilities.js";
import { diffCapabilities, diffHashes, type SegmentChanges } from "../../src/analyze/differ.js";
import { hashTool } from "../../src/analyze/hash.js";
import { detectPatterns } from "../../src/analyze/patterns.js";
import { TIER3_CAPABILITY_KEYS, classifyTier, isAutoPass, type TierDecision } from "../../src/analyze/tiers.js";
import { detectUnicode } from "../../src/analyze/unicode.js";
import { McpToolListSchema, TierSchema, type CapabilityDelta, type Finding, type McpTool } from "../../src/schema/index.js";

const fixtureTools = (name: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

const fixtureTool = (file: string, name: string): McpTool => fixtureTools(file).find((t) => t.name === name)!;

const NO_SEGMENTS: SegmentChanges = { name: false, description: false, inputSchema: false };
const DESCRIPTION_ONLY: SegmentChanges = { name: false, description: true, inputSchema: false };
const EMPTY_DELTA: CapabilityDelta = { gained: [], lost: [], loosened: [] };

const finding = (type: Finding["type"], severity: Finding["severity"], message = `${type} ${severity}`): Finding => ({
  type,
  severity,
  message,
  evidence: "x",
});

/**
 * The full pipeline the proxy will run for one tool: hash, extract, detect, diff, classify.
 * `before` null is a tool seen for the first time.
 */
function pipeline(before: McpTool | null, after: McpTool, otherServerTools: string[] = []): TierDecision {
  const extracted = extractCapabilities(after, otherServerTools);
  const findings = [
    ...extracted.findings,
    ...detectUnicode(after.description ?? "", "description"),
    ...detectPatterns(after.description ?? "", "description", { otherServerTools }),
  ];
  const segments = before ? diffHashes(hashTool(before), hashTool(after)) : { name: true, description: true, inputSchema: true };
  const beforeCaps = before ? extractCapabilities(before, otherServerTools).capabilities : null;
  return classifyTier(segments, diffCapabilities(beforeCaps, extracted.capabilities), findings);
}

describe("classifyTier on the fixtures", () => {
  const benign = fixtureTool("benign-tools.json", "get_forecast");

  it("hard-blocks the poisoned get_forecast rug pull (tier 3)", () => {
    expect(pipeline(benign, fixtureTool("poisoned-tools.json", "get_forecast"))).toEqual({
      tier: 3,
      reason: "Critical pattern finding: Text instructs the model and points it at a sensitive file (description) (and 4 more critical findings)",
    });
  });

  it("auto-passes a reworded description with identical capabilities (tier 0)", () => {
    expect(pipeline(benign, { ...benign, description: "Fetch the forecast for a location." })).toEqual({
      tier: 0,
      reason: "Text changed (description); capabilities unchanged",
    });
  });

  it("auto-passes a schema change that touches no capability (tier 0)", () => {
    const freeUnits = structuredClone(benign);
    freeUnits.inputSchema.properties = { ...freeUnits.inputSchema.properties, units: { type: "string" } };
    expect(pipeline(benign, freeUnits)).toEqual({ tier: 0, reason: "Text changed (inputSchema); capabilities unchanged" });
  });

  it("queues a path parameter loosened from enum to bare string (tier 2)", () => {
    const pinned: McpTool = {
      name: "read_report",
      description: "Read a report.",
      inputSchema: { type: "object", properties: { path: { type: "string", enum: ["/srv/reports/latest.pdf"] } } },
    };
    const loosened: McpTool = { ...pinned, inputSchema: { type: "object", properties: { path: { type: "string" } } } };
    expect(pipeline(pinned, loosened)).toEqual({ tier: 2, reason: "Loosened filesystem.scope" });
  });

  it("classifies the poisoned tools as new arrivals", () => {
    expect(pipeline(null, fixtureTool("poisoned-tools.json", "read_config"))).toEqual({
      tier: 2,
      reason: "Gained filesystem.read; loosened filesystem.scope",
    });
    expect(pipeline(null, fixtureTool("poisoned-tools.json", "run_diagnostics")).tier).toBe(3);
    expect(pipeline(null, fixtureTool("poisoned-tools.json", "sync_alerts"), ["send_email"]).tier).toBe(3);
  });

  it("reports an unchanged definition as tier 0, whatever its findings", () => {
    const poisoned = fixtureTool("poisoned-tools.json", "get_forecast");
    expect(pipeline(poisoned, structuredClone(poisoned))).toEqual({ tier: 0, reason: "Definition unchanged" });
    expect(pipeline(benign, structuredClone(benign))).toEqual({ tier: 0, reason: "Definition unchanged" });
  });
});

describe("classifyTier rules", () => {
  it("escalates to tier 3 on critical unicode, pattern and cross_server findings only", () => {
    for (const type of ["unicode", "pattern", "cross_server"] as const) {
      expect(classifyTier(DESCRIPTION_ONLY, EMPTY_DELTA, [finding(type, "critical")]).tier).toBe(3);
    }
    for (const type of ["annotation_mismatch", "capability_gain"] as const) {
      expect(classifyTier(DESCRIPTION_ONLY, EMPTY_DELTA, [finding(type, "critical")]).tier).toBe(0);
    }
    expect(classifyTier(DESCRIPTION_ONLY, EMPTY_DELTA, [finding("pattern", "warn"), finding("unicode", "info")]).tier).toBe(0);
  });

  it("names the first critical finding and counts the rest", () => {
    const findings = [finding("unicode", "warn"), finding("pattern", "critical", "first"), finding("unicode", "critical", "second")];
    expect(classifyTier(DESCRIPTION_ONLY, EMPTY_DELTA, findings).reason).toBe(
      "Critical pattern finding: first (and 1 more critical findings)",
    );
  });

  it("escalates to tier 3 on gaining exec, credentials or a cross-server reference", () => {
    for (const key of [...TIER3_CAPABILITY_KEYS, "crossServerRefs:send_email"]) {
      expect(classifyTier(NO_SEGMENTS, { gained: [key], lost: [], loosened: [] }, [])).toEqual({ tier: 3, reason: `Gained ${key}` });
    }
  });

  it("queues other gains and every loosening as tier 2", () => {
    expect(classifyTier(NO_SEGMENTS, { gained: ["network.egress"], lost: [], loosened: [] }, [])).toEqual({
      tier: 2,
      reason: "Gained network.egress",
    });
    expect(classifyTier(NO_SEGMENTS, { gained: [], lost: [], loosened: ["network.domains:evil.net"] }, [])).toEqual({
      tier: 2,
      reason: "Loosened network.domains:evil.net",
    });
  });

  it("treats a narrowing with nothing gained as tier 1, and a mixed change as tier 2", () => {
    expect(classifyTier(NO_SEGMENTS, { gained: [], lost: ["exec.shell", "filesystem.scope"], loosened: [] }, [])).toEqual({
      tier: 1,
      reason: "Narrowed: exec.shell, filesystem.scope",
    });
    expect(classifyTier(NO_SEGMENTS, { gained: ["filesystem.write"], lost: ["exec.shell"], loosened: [] }, []).tier).toBe(2);
  });

  it("classifies a capability change even when no hashed segment changed", () => {
    // Happens when the extractor itself changes: the delta, not the hashes, decides.
    expect(classifyTier(NO_SEGMENTS, { gained: ["network.egress"], lost: [], loosened: [] }, []).tier).toBe(2);
  });

  it("lists which segments changed for a tier 0 text change", () => {
    expect(classifyTier({ name: true, description: true, inputSchema: false }, EMPTY_DELTA, []).reason).toBe(
      "Text changed (name, description); capabilities unchanged",
    );
  });

  it("caps the keys named in a reason", () => {
    const gained = ["a", "b", "c", "d", "e", "f", "g"].map((k) => `network.domains:${k}`);
    expect(classifyTier(NO_SEGMENTS, { gained: [], lost: [], loosened: gained }, []).reason).toBe(
      "Loosened network.domains:a, network.domains:b, network.domains:c, network.domains:d, network.domains:e and 2 more",
    );
  });

  it("always returns a valid tier", () => {
    const cases: Array<Parameters<typeof classifyTier>> = [
      [NO_SEGMENTS, EMPTY_DELTA, []],
      [DESCRIPTION_ONLY, EMPTY_DELTA, [finding("pattern", "critical")]],
      [NO_SEGMENTS, { gained: ["exec.enabled"], lost: [], loosened: [] }, []],
      [NO_SEGMENTS, { gained: [], lost: ["exec.enabled"], loosened: [] }, []],
    ];
    for (const args of cases) expect(TierSchema.safeParse(classifyTier(...args).tier).success).toBe(true);
  });
});

describe("isAutoPass", () => {
  it("passes tiers 0 and 1 and blocks tiers 2 and 3", () => {
    expect([0, 1, 2, 3].map((tier) => isAutoPass(tier as 0 | 1 | 2 | 3))).toEqual([true, true, false, false]);
  });
});
