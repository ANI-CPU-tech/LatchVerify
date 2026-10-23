export interface ProxyOptions {
  /** Key of this server in latch.lock. */
  serverId: string;
  /** Real server executable and arguments. */
  command: string;
  args: string[];
  lockfilePath: string;
  stateDir: string;
}

/**
 * Run the stdio proxy until either side closes.
 * TODO: load the lockfile and pending queue, spawnUpstream(), readFrames() on our stdin and the
 * child's stdout, pass every frame through routeFrame(), and apply the decision (forward raw,
 * write rewritten, or respond to sender). Propagate SIGINT/SIGTERM to the child. Resolves with
 * the child's exit code.
 */
export async function startProxy(options: ProxyOptions): Promise<number> {
  throw new Error("not implemented");
}

export * from "./transport.js";
export * from "./interceptor.js";
export * from "./blocker.js";
