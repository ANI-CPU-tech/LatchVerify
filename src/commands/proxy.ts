import { resolve } from "node:path";
import type { LlmOptions } from "../analyze/llm.js";
import type { LogLevel } from "../config/env.js";
import { startAppIfStopped } from "../desktop/launch.js";
import { startProxy } from "../proxy/index.js";

export interface ProxyCommandOptions {
  serverId: string;
  /** Real server command followed by its args (everything after `--`). */
  command: string[];
  lockfilePath: string;
  stateDir: string;
  /** LLM advisory pass options, when LATCH_LLM_ENABLED is on. */
  llm?: LlmOptions;
  /** LATCH_LOG_LEVEL. */
  logLevel?: LogLevel;
}

/**
 * `latch proxy --server <id> -- <cmd> [args...]` (internal; written into client configs): resolves
 * the lockfile and state paths to absolute ones and runs startProxy(). Resolves with the real
 * server's exit code. stdout carries nothing but JSON-RPC: problems are thrown for the CLI to print
 * on stderr.
 *
 * @throws Error for a missing server id or command, or as startProxy does: a malformed
 * latch.lock or pending queue, or a server that cannot be started.
 */
export async function runProxy(options: ProxyCommandOptions): Promise<number> {
  if (options.serverId === "") {
    throw new Error("latch proxy: --server needs the server's id in latch.lock");
  }
  const [command, ...args] = options.command;
  if (command === undefined || command === "") {
    throw new Error("latch proxy: give the real server command after --, e.g. latch proxy --server weather -- npx my-server");
  }
  // An installed LatchVerify comes up with the client, in the tray (a no-op from a checkout).
  startAppIfStopped();
  return startProxy({
    serverId: options.serverId,
    command,
    args,
    lockfilePath: resolve(options.lockfilePath),
    stateDir: resolve(options.stateDir),
    llm: options.llm,
    logLevel: options.logLevel,
  });
}
