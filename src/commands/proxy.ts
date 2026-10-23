import { resolve } from "node:path";
import { startProxy } from "../proxy/index.js";

export interface ProxyCommandOptions {
  serverId: string;
  /** Real server command followed by its args (everything after `--`). */
  command: string[];
  lockfilePath: string;
  stateDir: string;
}

/** What src/cli.ts passes for --lockfile and --state-dir when they are not given. */
const CLI_DEFAULT_LOCKFILE = "./latch.lock";
const CLI_DEFAULT_STATE_DIR = "./.latch";

/**
 * `latch proxy --server <id> -- <cmd> [args...]` (internal; written into client configs by init)
 *
 * Checks that a server id and a command were given, resolves the lockfile and state paths to
 * absolute ones, and delegates to startProxy(). Resolves with the real server's exit code.
 *
 * Clients launch servers from a working directory of their choosing (Claude Desktop uses "/"),
 * and a wrapped entry has nowhere to put global flags, so LATCH_LOCKFILE_PATH and LATCH_STATE_DIR
 * from the entry's `env` apply when --lockfile or --state-dir was not given. An explicit flag
 * wins. As in loadEnv(), values are trimmed, blank means unset, and relative paths resolve
 * against the working directory.
 *
 * stdout carries nothing but JSON-RPC: problems are thrown for the CLI to print on stderr, and
 * the proxy logs to stderr and .latch/events.jsonl.
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
  return startProxy({
    serverId: options.serverId,
    command,
    args,
    lockfilePath: pathOption(options.lockfilePath, CLI_DEFAULT_LOCKFILE, process.env.LATCH_LOCKFILE_PATH),
    stateDir: pathOption(options.stateDir, CLI_DEFAULT_STATE_DIR, process.env.LATCH_STATE_DIR),
  });
}

/** The flag's value, or the environment's when the flag was left at the CLI default; absolute. */
function pathOption(given: string, cliDefault: string, fromEnv: string | undefined): string {
  const env = fromEnv?.trim();
  return resolve(given === cliDefault && env !== undefined && env !== "" ? env : given);
}
