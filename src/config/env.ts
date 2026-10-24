import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "../analyze/llm.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Runtime configuration resolved from process.env (see .env.example). */
export interface LatchEnv {
  llmApiKey: string | undefined;
  llmEnabled: boolean;
  /** OpenAI-compatible API root for the advisory pass. */
  llmBaseUrl: string;
  llmModel: string;
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
 * | LATCH_LLM_API_KEY     | none           | any non-blank string                       |
 * | LATCH_LLM_ENABLED     | false          | true/false, 1/0, yes/no, on/off (any case) |
 * | LATCH_LLM_BASE_URL    | DEFAULT_LLM_BASE_URL | an OpenAI-compatible API root        |
 * | LATCH_LLM_MODEL       | DEFAULT_LLM_MODEL | a model id served at the base URL       |
 * | LATCH_UI_PORT         | 7777           | a decimal integer from 1 to 65535          |
 * | LATCH_LOCKFILE_PATH   | ./latch.lock   | a path, resolved against the cwd           |
 * | LATCH_STATE_DIR       | <lockfile dir>/.latch | a path, resolved against the cwd    |
 * | LATCH_LOG_LEVEL       | info           | debug, info, warn, error (any case)        |
 *
 * LATCH_REVIEWER (who approvals are recorded as) is read by defaultReviewer() in ui/server.ts.
 *
 * Values are trimmed, and a blank value counts as unset, so `LATCH_LLM_API_KEY=` copied from
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

  const llmApiKey = read("LATCH_LLM_API_KEY");

  let llmEnabled = false;
  const llm = read("LATCH_LLM_ENABLED");
  if (llm !== undefined) {
    const word = llm.toLowerCase();
    if (TRUE_WORDS.has(word)) llmEnabled = true;
    else if (!FALSE_WORDS.has(word)) problems.push(`LATCH_LLM_ENABLED must be true or false, got ${JSON.stringify(llm)}`);
  }
  if (llmEnabled && llmApiKey === undefined) {
    problems.push("LATCH_LLM_ENABLED is true but LATCH_LLM_API_KEY is not set");
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
    llmApiKey,
    llmEnabled,
    llmBaseUrl: read("LATCH_LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL,
    llmModel: read("LATCH_LLM_MODEL") ?? DEFAULT_LLM_MODEL,
    uiPort,
    ...statePaths({}, env),
    logLevel,
  };
}

/** Load `path` (./.env) into process.env when it exists. Variables already set win over the file. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * The lockfile and state directory every command uses, absolute: a flag wins, then
 * LATCH_LOCKFILE_PATH / LATCH_STATE_DIR (trimmed, blank is unset), then ./latch.lock and the
 * `.latch` directory next to the lockfile. One default for all, so the proxy (started by a client
 * in any directory), `latch review` and the UI read and write the same queue.
 *
 * With `fallbackLockfile` (the per-user latch.lock, for commands that only read or review it),
 * that file is used instead of the default when ./latch.lock does not exist and it does: an
 * installed latch opens the user's pins from any directory, while a project's own latch.lock
 * still wins inside the project.
 */
export function statePaths(
  flags: { lockfile?: string; stateDir?: string },
  env: NodeJS.ProcessEnv = process.env,
  { fallbackLockfile, exists = existsSync }: { fallbackLockfile?: string; exists?: (path: string) => boolean } = {},
): { lockfilePath: string; stateDir: string } {
  const read = (name: string) => env[name]?.trim() || undefined;
  const local = resolve("./latch.lock");
  const fallback = fallbackLockfile !== undefined && !exists(local) && exists(fallbackLockfile) ? fallbackLockfile : undefined;
  const lockfilePath = resolve(flags.lockfile ?? read("LATCH_LOCKFILE_PATH") ?? fallback ?? local);
  return { lockfilePath, stateDir: resolve(flags.stateDir ?? read("LATCH_STATE_DIR") ?? join(dirname(lockfilePath), ".latch")) };
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
