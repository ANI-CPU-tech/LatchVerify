import type { ClientId } from "../config/clients.js";

export interface InitOptions {
  /** Restrict to one client; default is every detected client. */
  client?: ClientId;
  /** Print the planned config rewrites without writing anything. */
  dryRun: boolean;
  lockfilePath: string;
}

/**
 * `latch init`
 * TODO: detectClients(), let the user pick servers with @clack/prompts multiselect, rewrite each
 * chosen entry with wrapWithProxy() (backing up the original config), capture each server's
 * tools/list once, and write an initial latch.lock with every tool pinned under the current git
 * user. Resolves with the process exit code.
 */
export async function runInit(options: InitOptions): Promise<number> {
  throw new Error("not implemented");
}
