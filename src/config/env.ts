export type LogLevel = "debug" | "info" | "warn" | "error";

/** Runtime configuration resolved from process.env (see .env.example). */
export interface LatchEnv {
  anthropicApiKey: string | undefined;
  llmEnabled: boolean;
  uiPort: number;
  lockfilePath: string;
  stateDir: string;
  logLevel: LogLevel;
}

/**
 * Resolve LatchEnv from an environment map.
 * TODO: read ANTHROPIC_API_KEY, LATCH_LLM_ENABLED (default false), LATCH_UI_PORT (default 7777),
 * LATCH_LOCKFILE_PATH (default ./latch.lock), LATCH_STATE_DIR (default ./.latch) and
 * LATCH_LOG_LEVEL (default info); resolve paths against cwd; throw a readable error on
 * malformed values (non-numeric port, unknown log level, LLM enabled without an API key).
 * Returns the parsed config.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): LatchEnv {
  throw new Error("not implemented");
}
