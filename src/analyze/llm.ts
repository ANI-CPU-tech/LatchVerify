import type { LlmAdvisory, McpTool, Sha256Hex } from "../schema/index.js";

/** Pass 3 is off by default and only runs with LATCH_LLM_ENABLED=true and an API key. */
export interface LlmOptions {
  apiKey: string;
  model: string;
}

/** Model used for the advisory pass unless overridden. */
export const DEFAULT_LLM_MODEL = "claude-haiku-5-5";

/**
 * TODO: sha256 over canonicalJson({ name, description, inputSchema, model }). The advisory is
 * keyed by this so the same definition never triggers a second model call.
 */
export function advisoryCacheKey(tool: McpTool, model: string): Sha256Hex {
  throw new Error("not implemented");
}

/**
 * Optional LLM advisory pass.
 * TODO: if `cached` has the same contentHash, return it unchanged (no API call, no phantom
 * drift). Otherwise call @anthropic-ai/sdk messages.create with temperature 0 and a prompt
 * asking for hidden-instruction and capability findings as strict JSON, validate with
 * FindingSchema, and return a new LlmAdvisory. Advisory findings never narrow pass-1 results.
 */
export async function runAdvisory(tool: McpTool, options: LlmOptions, cached?: LlmAdvisory): Promise<LlmAdvisory> {
  throw new Error("not implemented");
}
