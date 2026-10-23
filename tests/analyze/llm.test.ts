import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADVISORY_PROMPT_VERSION, advisoryCacheKey } from "../../src/analyze/llm.js";
import { McpToolListSchema, Sha256HexSchema, type McpTool } from "../../src/schema/index.js";

const tools = (file: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"))).tools;
const forecast = tools("benign-tools.json")[0]!;
const MODEL = "llama-3.3-70b-versatile";

/** Same value with every object's keys in reverse insertion order. */
const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]))
      : value;

describe("advisoryCacheKey", () => {
  it("is a SHA-256 hex digest and deterministic", () => {
    const key = advisoryCacheKey(forecast, MODEL);
    expect(Sha256HexSchema.safeParse(key).success).toBe(true);
    expect(advisoryCacheKey(structuredClone(forecast), MODEL)).toBe(key);
  });

  it("ignores key order and fields outside the hashed segments", () => {
    const reordered = reverseKeys(forecast) as McpTool;
    expect(advisoryCacheKey({ ...reordered, title: "other", annotations: { readOnlyHint: false } }, MODEL)).toBe(advisoryCacheKey(forecast, MODEL));
  });

  it("changes with the name, description, input schema or model", () => {
    const base = advisoryCacheKey(forecast, MODEL);
    const variants = [
      advisoryCacheKey({ ...forecast, name: "x" }, MODEL),
      advisoryCacheKey({ ...forecast, description: `${forecast.description}\u{200b}` }, MODEL),
      advisoryCacheKey({ ...forecast, inputSchema: { type: "object" } }, MODEL),
      advisoryCacheKey(forecast, "another-model"),
    ];
    expect(new Set([base, ...variants]).size).toBe(5);
  });

  it("treats a missing description as empty", () => {
    const { description: _omit, ...bare } = forecast;
    expect(advisoryCacheKey(bare, MODEL)).toBe(advisoryCacheKey({ ...forecast, description: "" }, MODEL));
  });

  it("has a prompt version", () => {
    expect(ADVISORY_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
