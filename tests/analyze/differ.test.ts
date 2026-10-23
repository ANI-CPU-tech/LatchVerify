import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashTool } from "../../src/analyze/hash.js";
import { anySegmentChanged, diffHashes } from "../../src/analyze/differ.js";
import { McpToolListSchema, type McpTool } from "../../src/schema/index.js";

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
