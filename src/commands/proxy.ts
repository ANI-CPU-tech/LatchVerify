export interface ProxyCommandOptions {
  serverId: string;
  /** Real server command followed by its args (everything after `--`). */
  command: string[];
  lockfilePath: string;
  stateDir: string;
}

/**
 * `latch proxy --server <id> -- <cmd> [args...]` (internal; written into client configs by init)
 * TODO: validate that a command was given, then delegate to startProxy() and resolve with its exit
 * code. Must never write anything but JSON-RPC to stdout: logs go to stderr and .latch/events.jsonl.
 */
export async function runProxy(options: ProxyCommandOptions): Promise<number> {
  throw new Error("not implemented");
}
