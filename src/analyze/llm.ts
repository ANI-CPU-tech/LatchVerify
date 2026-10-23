import { FindingSchema, FindingTypeSchema, type Finding, type LlmAdvisory, type McpTool, type Sha256Hex } from "../schema/index.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { escapeForEvidence } from "./unicode.js";

/**
 * Pass 3 (optional, off by default): an LLM reviews a tool definition and reports findings the
 * deterministic passes might miss. Any OpenAI-compatible chat-completions API works, including
 * the free tiers of Groq and OpenRouter. It only runs with LATCH_LLM_ENABLED=true and an API key.
 */
export interface LlmOptions {
  apiKey: string;
  model: string;
  /** API root without the trailing "/chat/completions". Defaults to DEFAULT_LLM_BASE_URL. */
  baseUrl?: string;
}

/** Groq's OpenAI-compatible endpoint, which has a free tier. OpenRouter: https://openrouter.ai/api/v1. */
export const DEFAULT_LLM_BASE_URL = "https://api.groq.com/openai/v1";

/** Model used for the advisory pass unless overridden. Must be available at the base URL. */
export const DEFAULT_LLM_MODEL = "llama-3.3-70b-versatile";

/**
 * Version of the advisory prompt and output rules. Part of the cache key, so changing the prompt
 * re-reviews every tool once instead of silently mixing results from two prompts.
 */
export const ADVISORY_PROMPT_VERSION = "1";

/**
 * Cache key for one tool's advisory: sha256 of the canonical JSON of the hashed tool segments,
 * the model and the prompt version. The advisory is stored in latch.lock under this key, so the
 * same definition reviewed by the same model never triggers a second call and never drifts.
 */
export function advisoryCacheKey(tool: McpTool, model: string): Sha256Hex {
  return sha256Hex(
    canonicalJson({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      model,
      prompt: ADVISORY_PROMPT_VERSION,
    }),
  );
}

/** The advisory pass failed: unreachable API, an error status, or output that is not JSON. */
export class LlmError extends Error {
  override readonly name = "LlmError";

  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Most findings kept from one review, and the longest message or evidence kept from each. */
export const MAX_ADVISORY_FINDINGS = 10;
export const MAX_ADVISORY_TEXT = 300;

/** Model output as printable ASCII, truncated: it is untrusted text shown to reviewers. */
function clean(value: string): string {
  const chars = [...value.trim()];
  const text = chars.length > MAX_ADVISORY_TEXT ? `${chars.slice(0, MAX_ADVISORY_TEXT).join("")}...` : chars.join("");
  return escapeForEvidence(text).slice(1, -1);
}

/** The JSON value in a model reply, tolerating code fences and prose around it. */
function extractJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.search(/[[{]/);
    const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (start === -1 || end <= start) throw new LlmError("the model did not answer with JSON");
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch (error) {
      throw new LlmError("the model did not answer with valid JSON", undefined, { cause: error });
    }
  }
}

/**
 * Findings from a model reply of the form `{"findings": [...]}` (a bare array is accepted too).
 * The reply is untrusted, so each item is checked: entries without a known type, a message and
 * evidence are dropped, text is truncated and rendered as printable ASCII, and at most
 * MAX_ADVISORY_FINDINGS are kept. Severity is capped at "warn": the advisory informs reviewers
 * but never blocks a tool on its own, since a model can be wrong or be manipulated by the very
 * text it reviews. Throws LlmError when the reply holds no JSON findings list.
 */
export function parseAdvisoryFindings(reply: string): Finding[] {
  const data = extractJson(reply);
  const items = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && "findings" in data && Array.isArray(data.findings)
      ? data.findings
      : undefined;
  if (!items) throw new LlmError('the model reply has no "findings" list');

  const findings: Finding[] = [];
  for (const item of items as unknown[]) {
    if (findings.length === MAX_ADVISORY_FINDINGS) break;
    if (typeof item !== "object" || item === null) continue;
    const { type, severity, message, evidence } = item as Record<string, unknown>;
    const knownType = FindingTypeSchema.safeParse(type);
    if (!knownType.success || typeof message !== "string" || typeof evidence !== "string" || message.trim() === "") continue;
    findings.push(
      FindingSchema.parse({
        type: knownType.data,
        severity: severity === "info" ? "info" : "warn",
        message: `LLM advisory: ${clean(message)}`,
        evidence: clean(evidence),
      }),
    );
  }
  return findings;
}

/**
 * Optional LLM advisory pass.
 * TODO: if `cached` has the same contentHash, return it unchanged (no API call, no phantom
 * drift). Otherwise call the API with temperature 0 and validate the findings.
 */
export async function runAdvisory(tool: McpTool, options: LlmOptions, cached?: LlmAdvisory): Promise<LlmAdvisory> {
  throw new Error("not implemented");
}
