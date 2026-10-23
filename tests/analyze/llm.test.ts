import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADVISORY_PROMPT_VERSION,
  LlmError,
  MAX_ADVISORY_FINDINGS,
  MAX_ADVISORY_TEXT,
  advisoryCacheKey,
  parseAdvisoryFindings,
} from "../../src/analyze/llm.js";
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

describe("parseAdvisoryFindings", () => {
  const finding = { type: "pattern", severity: "warn", message: "Asks for the SSH key", evidence: "read ~/.ssh/id_rsa" };

  it("reads a findings object and prefixes each message", () => {
    expect(parseAdvisoryFindings(JSON.stringify({ findings: [finding] }))).toEqual([
      { type: "pattern", severity: "warn", message: "LLM advisory: Asks for the SSH key", evidence: "read ~/.ssh/id_rsa" },
    ]);
    expect(parseAdvisoryFindings(JSON.stringify({ findings: [] }))).toEqual([]);
  });

  it("accepts a bare array, code fences and prose around the JSON", () => {
    expect(parseAdvisoryFindings(JSON.stringify([finding]))).toHaveLength(1);
    expect(parseAdvisoryFindings("```json\n" + JSON.stringify({ findings: [finding] }) + "\n```")).toHaveLength(1);
    expect(parseAdvisoryFindings(`Here you go:\n${JSON.stringify({ findings: [finding] })}\nThanks.`)).toHaveLength(1);
  });

  it("caps severity at warn, so the advisory never hard-blocks a tool", () => {
    const [capped] = parseAdvisoryFindings(JSON.stringify({ findings: [{ ...finding, severity: "critical" }] }));
    expect(capped!.severity).toBe("warn");
    expect(parseAdvisoryFindings(JSON.stringify({ findings: [{ ...finding, severity: "info" }] }))[0]!.severity).toBe("info");
    expect(parseAdvisoryFindings(JSON.stringify({ findings: [{ ...finding, severity: "bogus" }] }))[0]!.severity).toBe("warn");
  });

  it("drops entries with an unknown type, a missing message or evidence, or that are not objects", () => {
    const items = [{ ...finding, type: "vibes" }, { ...finding, message: "  " }, { ...finding, evidence: 3 }, "text", null, finding];
    expect(parseAdvisoryFindings(JSON.stringify({ findings: items }))).toHaveLength(1);
  });

  it(`keeps at most ${MAX_ADVISORY_FINDINGS} findings and truncates long text`, () => {
    const many = Array.from({ length: 50 }, () => ({ ...finding, message: "m".repeat(5_000) }));
    const findings = parseAdvisoryFindings(JSON.stringify({ findings: many }));
    expect(findings).toHaveLength(MAX_ADVISORY_FINDINGS);
    expect(findings[0]!.message).toBe(`LLM advisory: ${"m".repeat(MAX_ADVISORY_TEXT)}...`);
  });

  it("renders model text as printable ASCII so it cannot hide characters", () => {
    const [sneaky] = parseAdvisoryFindings(JSON.stringify({ findings: [{ ...finding, message: "ok\u{200b}\u{202e}", evidence: "a\nb" }] }));
    expect(sneaky!.message).toBe("LLM advisory: ok[U+200B][U+202E]");
    expect(sneaky!.evidence).toBe("a[U+000A]b");
  });

  it("throws LlmError when the reply has no JSON findings list", () => {
    for (const reply of ["no json here", "{ broken", JSON.stringify({ result: [] }), JSON.stringify("findings")]) {
      expect(() => parseAdvisoryFindings(reply)).toThrow(LlmError);
    }
  });
});
