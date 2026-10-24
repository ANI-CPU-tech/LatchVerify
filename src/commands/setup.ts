import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { clientConfigPath, detectClients, type ClientId, type ProxyLaunch } from "../config/clients.js";
import { emptyLockfile, writeLockfile } from "../store/lockfile.js";
import { runInit } from "./init.js";
import { printable } from "./text.js";

/** How each client is named to people. */
export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
};

export interface SetupOptions {
  /** The client to link. The CLI defaults it to claude-code. */
  client: ClientId;
  /** Show what would change without writing. */
  dryRun: boolean;
  /** The lockfile to create and link to. The CLI defaults it to userLockfilePath(). */
  lockfilePath: string;
  /** State directory written into each wrapped entry. Defaults to .latch next to the lockfile. */
  stateDir?: string;
  /** Who first-use pins are recorded as. Defaults to init's defaultReviewer(). */
  reviewer?: string;
  /** Deadline for capturing each server's tools. */
  timeoutMs?: number;
  /** Where progress is written. Defaults to process.stdout. */
  output?: Writable;
  /** How wrapped entries start latch. Defaults to this install, by absolute path. */
  launch?: ProxyLaunch;
}

/**
 * `latch setup`: link a client (Claude Code by default) to latch with no questions, as installers
 * run it right after installing.
 *
 * 1. Creates the lockfile (by default the per-user one, see userLockfilePath) if it does not exist,
 *    so latch review and verify find it from any directory without asking.
 * 2. When the client's config exists, runs `latch init` for that client, non-interactively: every
 *    stdio server is pinned (trust on first use; tools with hidden-intent findings are held for
 *    review) and its entry rewritten to start `latch proxy`, with a .bak of the config.
 *
 * Safe to run again: pinned servers stay as pinned and wrapped entries are left alone. When the
 * client is not installed yet it says so and resolves 0, so an installer never fails over it; run
 * `latch setup` again after installing the client.
 *
 * Resolves with init's result: 0 when every server was handled, 1 when any was skipped or failed.
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const name = CLIENT_NAMES[options.client];
  const lockfilePath = resolve(options.lockfilePath);

  say(pc.bold(`latch setup: linking ${name} to ${printable(lockfilePath)}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));

  const installed = (await detectClients()).some((config) => config.client === options.client);
  let code = 0;
  if (installed) {
    code = await runInit({
      client: options.client,
      dryRun: options.dryRun,
      lockfilePath,
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.launch === undefined ? {} : { launch: options.launch }),
      output: out,
      interactive: false,
      hints: false,
    });
  } else {
    say(pc.yellow(`! ${name} is not set up on this machine yet (no ${printable(clientConfigPath(options.client))}).`));
    say(`  LatchVerify is installed. After installing ${name}, run \`latch setup\` again to link it.`);
  }

  // The lockfile exists after setup even when there was nothing to pin, so review and verify open it.
  if (!existsSync(lockfilePath)) {
    if (options.dryRun) {
      say(`would create ${printable(lockfilePath)}`);
    } else {
      await mkdir(dirname(lockfilePath), { recursive: true });
      await writeLockfile(lockfilePath, emptyLockfile());
      say(`${pc.green("✔")} created ${printable(lockfilePath)}`);
    }
  }

  say();
  if (installed && !options.dryRun) say(`next: restart ${name} so its MCP servers start behind latch`);
  say(`next: review tool changes with \`latch review --ui\` (it opens ${printable(lockfilePath)} from any directory)`);
  return code;
}
