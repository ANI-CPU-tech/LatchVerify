import type { LlmAdvisory, McpTool, Sha256Hex } from "../schema/index.js";
import { canonicalJson, sha256Hex } from "./hash.js";

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

/**
 * Optional LLM advisory pass.
 * TODO: if `cached` has the same contentHash, return it unchanged (no API call, no phantom
 * drift). Otherwise call the API with temperature 0 and validate the findings.
 */
export async function runAdvisory(tool: McpTool, options: LlmOptions, cached?: LlmAdvisory): Promise<LlmAdvisory> {
  throw new Error("not implemented");
}
