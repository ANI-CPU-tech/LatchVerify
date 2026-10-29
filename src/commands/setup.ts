import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { clientConfigPath, detectClients, unwrapProxy, writeClientConfig, type ClientId, type ClientServerEntry, type ProxyLaunch } from "../config/clients.js";
import { emptyLockfile, writeLockfile } from "../store/lockfile.js";
import { runInit } from "./init.js";
import { plural, printable, problemWarning } from "./text.js";

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

  const detection = await detectClients();
  const installed = detection.configs.some((config) => config.client === options.client);
  const problem = detection.problems.find((candidate) => candidate.client === options.client);
  let code = 0;
  if (problem !== undefined) {
    say(pc.yellow(problemWarning(problem)));
    say(`  Fix the file, or let ${name} rewrite it, then run \`latch setup\` again.`);
    code = 1;
  } else if (installed) {
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

/** Variables latch init adds to a wrapped entry's env; unlinking removes exactly these. */
const LATCH_ENTRY_ENV = ["LATCH_LOCKFILE_PATH", "LATCH_STATE_DIR"] as const;

export interface UnlinkOptions {
  client: ClientId;
  dryRun: boolean;
  output?: Writable;
}

/**
 * `latch setup --remove`: undo the link, as uninstallers run it before removing latch. Every entry
 * in the client's config that starts `latch proxy` gets its real command and arguments back, and
 * loses the LATCH_* variables init added; its other env and keys stay. The config keeps a .bak
 * copy. latch.lock is not touched, so reinstalling keeps the approvals.
 *
 * Resolves 0 when the config was restored or had nothing to restore (or the client is not
 * installed), 1 when the config could not be rewritten.
 */
export async function runUnlink(options: UnlinkOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const name = CLIENT_NAMES[options.client];
  say(pc.bold(`latch setup --remove: unlinking ${name}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));

  const detection = await detectClients();
  const problem = detection.problems.find((candidate) => candidate.client === options.client);
  if (problem !== undefined) {
    say(pc.red(problemWarning(problem)));
    return 1;
  }
  const config = detection.configs.find((candidate) => candidate.client === options.client);
  if (config === undefined) {
    say(`nothing to unlink: ${name} is not set up on this machine (no ${printable(clientConfigPath(options.client))})`);
    return 0;
  }

  const restored: Record<string, ClientServerEntry> = {};
  for (const [serverId, entry] of Object.entries(config.servers)) {
    const real = unwrapProxy(entry);
    if (real === entry) continue;
    restored[serverId] = withoutLatchEnv(real);
  }
  const ids = Object.keys(restored);
  if (ids.length === 0) {
    say(`nothing to unlink: no server in ${printable(config.path)} runs through latch`);
    return 0;
  }
  if (options.dryRun) {
    say(`would restore ${plural(ids.length, "server")} in ${printable(config.path)}, keeping a .bak copy: ${printable(ids.join(", "))}`);
    return 0;
  }
  try {
    await writeClientConfig({ ...config, servers: restored });
  } catch (error) {
    say(pc.red(`✖ could not rewrite ${printable(config.path)}: ${printable(error instanceof Error ? error.message : String(error))}`));
    return 1;
  }
  say(`${pc.green("✔")} restored ${plural(ids.length, "server")} in ${printable(config.path)} (the previous file is kept as a .bak copy): ${printable(ids.join(", "))}`);
  say(`next: restart ${name}. latch.lock is kept, so linking again later keeps your approvals.`);
  return 0;
}

/** `entry` without the env variables latch init added; an env left empty is dropped. */
function withoutLatchEnv(entry: ClientServerEntry): ClientServerEntry {
  if (typeof entry.env !== "object" || entry.env === null) return entry;
  const env = Object.fromEntries(Object.entries(entry.env).filter(([key]) => !(LATCH_ENTRY_ENV as readonly string[]).includes(key)));
  const { env: _dropped, ...rest } = entry;
  return Object.keys(env).length > 0 ? { ...rest, env } : rest;
}
