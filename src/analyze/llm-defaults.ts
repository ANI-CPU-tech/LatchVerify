// The advisory pass's defaults, apart from llm.ts so reading the environment (config/env.ts) does
// not load the LLM client and its schemas into every latch process.

/** Groq's OpenAI-compatible endpoint, which has a free tier. OpenRouter: https://openrouter.ai/api/v1. */
export const DEFAULT_LLM_BASE_URL = "https://api.groq.com/openai/v1";

/** Model used for the advisory pass unless overridden. Must be available at the base URL. */
export const DEFAULT_LLM_MODEL = "llama-3.3-70b-versatile";
