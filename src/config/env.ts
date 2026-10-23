import { resolve } from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Runtime configuration resolved from process.env (see .env.example). */
export interface LatchEnv {
  anthropicApiKey: string | undefined;
  llmEnabled: boolean;
  uiPort: number;
  lockfilePath: string;
  stateDir: string;
  logLevel: LogLevel;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/**
 * Resolve LatchEnv from an environment map, with the defaults from .env.example:
 *
 * | Variable              | Default        | Accepts                                    |
 * |-----------------------|----------------|--------------------------------------------|
 * | ANTHROPIC_API_KEY     | none           | any non-blank string                       |
 * | LATCH_LLM_ENABLED     | false          | true/false, 1/0, yes/no, on/off (any case) |
 * | LATCH_UI_PORT         | 7777           | a decimal integer from 1 to 65535          |
 * | LATCH_LOCKFILE_PATH   | ./latch.lock   | a path, resolved against the cwd           |
 * | LATCH_STATE_DIR       | ./.latch       | a path, resolved against the cwd           |
 * | LATCH_LOG_LEVEL       | info           | debug, info, warn, error (any case)        |
 *
 * Values are trimmed, and a blank value counts as unset, so `ANTHROPIC_API_KEY=` copied from
 * .env.example means "no key".
 *
 * @throws Error listing every malformed variable by name (non-numeric or out-of-range port,
 * unknown log level, unrecognized boolean, LLM pass enabled without an API key), so one run
 * shows everything to fix.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): LatchEnv {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };

  const anthropicApiKey = read("ANTHROPIC_API_KEY");

  let llmEnabled = false;
  const llm = read("LATCH_LLM_ENABLED");
  if (llm !== undefined) {
    const word = llm.toLowerCase();
    if (TRUE_WORDS.has(word)) llmEnabled = true;
    else if (!FALSE_WORDS.has(word)) problems.push(`LATCH_LLM_ENABLED must be true or false, got ${JSON.stringify(llm)}`);
  }
  if (llmEnabled && anthropicApiKey === undefined) {
    problems.push("LATCH_LLM_ENABLED is true but ANTHROPIC_API_KEY is not set");
  }

  let uiPort = 7777;
  const port = read("LATCH_UI_PORT");
  if (port !== undefined) {
    const parsed = /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN;
    if (parsed >= 1 && parsed <= 65535) uiPort = parsed;
    else problems.push(`LATCH_UI_PORT must be a port number from 1 to 65535, got ${JSON.stringify(port)}`);
  }

  let logLevel: LogLevel = "info";
  const level = read("LATCH_LOG_LEVEL");
  if (level !== undefined) {
    const lower = level.toLowerCase();
    if (isLogLevel(lower)) logLevel = lower;
    else problems.push(`LATCH_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(level)}`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid LatchVerify environment:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  return {
    anthropicApiKey,
    llmEnabled,
    uiPort,
    lockfilePath: resolve(read("LATCH_LOCKFILE_PATH") ?? "./latch.lock"),
    stateDir: resolve(read("LATCH_STATE_DIR") ?? "./.latch"),
    logLevel,
  };
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
