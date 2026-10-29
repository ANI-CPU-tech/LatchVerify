import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { clientConfigPath, detectClients, unwrapProxy, withoutLatchEnv, writeClientConfig, type ClientId, type ClientServerEntry, type ProxyLaunch } from "../config/clients.js";
import { emptyLockfile, writeLockfile } from "../store/lockfile.js";
import { runInit } from "./init.js";
import { configPlace, plural, printable, problemWarning } from "./text.js";

/** How each client is named to people. */
export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  vscodium: "VSCodium",
  cline: "Cline (VS Code)",
  "cline-cli": "Cline CLI",
  "gemini-cli": "Gemini CLI",
  zed: "Zed",
  "lm-studio": "LM Studio",
  "amazon-q": "Amazon Q Developer",
};

export interface SetupOptions {
  /** The client to link, or undefined for every client found (`--all`). The CLI defaults it to claude-code. */
  client: ClientId | undefined;
  /** Show what would change without writing. */
  dryRun: boolean;
  /** The lockfile to create and link to. The CLI defaults it to userLockfilePath(). */
  lockfilePath: string;
  /** State directory written into each wrapped entry. Defaults to .latch next to the lockfile. */
  stateDir?: string;
  /** Where progress is written. Defaults to process.stdout. */
  output?: Writable;
  /** How wrapped entries start latch. Defaults to this install, by absolute path. */
  launch?: ProxyLaunch;
}

/**
 * `latch setup`: link a client (Claude Code by default), or with `--all` every client found, to
 * latch with no questions, as installers run it right after installing.
 *
 * 1. Creates the lockfile (by default the per-user one, see userLockfilePath) if it does not exist,
 *    so latch review and verify find it from any directory without asking.
 * 2. When the client's config exists, runs `latch init` for that client (or all), non-interactively: every
 *    stdio server is pinned (trust on first use; tools with hidden-intent findings are held for
 *    review) and its entry rewritten to start `latch proxy` (command and args only; env is never touched).
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
  const client = options.client;
  const name = client === undefined ? "every MCP client found" : CLIENT_NAMES[client];
  const lockfilePath = resolve(options.lockfilePath);

  say(pc.bold(`latch setup: linking ${name} to ${printable(lockfilePath)}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));

  const detection = await detectClients();
  const mine = (config: { client: ClientId }) => client === undefined || config.client === client;
  const linked = [...new Set(detection.configs.filter(mine).map((config) => config.client))];
  const problems = detection.problems.filter(mine);
  let code = 0;
  let initRan = false;
  if (client !== undefined && problems.length > 0) {
    for (const problem of problems) say(pc.yellow(problemWarning(problem)));
    say(`  Fix the file, or let ${name} rewrite it, then run \`latch setup\` again.`);
    code = 1;
  } else if (linked.length > 0 || problems.length > 0) {
    // init reports the problems of --all itself, and links every config it can read.
    initRan = true;
    code = await runInit({
      ...(client === undefined ? {} : { client }),
      dryRun: options.dryRun,
      lockfilePath,
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.launch === undefined ? {} : { launch: options.launch }),
      output: out,
      interactive: false,
      hints: false,
    });
  } else if (client === undefined) {
    say(pc.yellow("! no MCP client is set up on this machine yet."));
    say("  LatchVerify is installed. After installing an MCP client, run `latch setup --all` again to link it.");
  } else {
    say(pc.yellow(`! ${name} is not set up on this machine yet (no ${printable(clientConfigPath(client))}).`));
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
  // Even when some server or config failed, the clients init could link must be restarted.
  if (initRan && linked.length > 0 && !options.dryRun) {
    say(`next: restart ${listOf(linked.map((id) => CLIENT_NAMES[id]))} so ${linked.length === 1 ? "its" : "their"} MCP servers start behind latch`);
  }
  say(`next: review tool changes with \`latch review --ui\` (it opens ${printable(lockfilePath)} from any directory)`);
  return code;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}


export interface UnlinkOptions {
  /** The client to unlink, or undefined for every client (`--remove --all`, as uninstallers run it). */
  client: ClientId | undefined;
  dryRun: boolean;
  output?: Writable;
}

/**
 * `latch setup --remove`: undo the link, as uninstallers run it before removing latch. Every entry
 * in the client's config that starts `latch proxy` gets its real command and arguments back, and
 * loses the LATCH_* variables older versions of init added; its other env and keys stay. latch.lock
 * is not touched, so reinstalling keeps the approvals.
 *
 * Resolves 0 when the config was restored or had nothing to restore (or the client is not
 * installed), 1 when the config could not be rewritten.
 */
export async function runUnlink(options: UnlinkOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const client = options.client;
  const name = client === undefined ? "every MCP client" : CLIENT_NAMES[client];
  say(pc.bold(`latch setup --remove: unlinking ${name}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));

  const detection = await detectClients();
  const mine = (config: { client: ClientId }) => client === undefined || config.client === client;
  const problems = detection.problems.filter(mine);
  for (const problem of problems) say(pc.red(problemWarning(problem)));
  const configs = detection.configs.filter(mine);
  if (configs.length === 0) {
    if (problems.length === 0) {
      say(client === undefined ? "nothing to unlink: no MCP client is set up on this machine" : `nothing to unlink: ${name} is not set up on this machine (no ${printable(clientConfigPath(client))})`);
    }
    return problems.length > 0 ? 1 : 0;
  }

  // A client can keep servers in more than one file (Amazon Q): each is restored on its own.
  let code = problems.length > 0 ? 1 : 0;
  const restoredClients = new Set<ClientId>();
  for (const config of configs) {
    const restored: Record<string, ClientServerEntry> = {};
    for (const [serverId, entry] of Object.entries(config.servers)) {
      const real = unwrapProxy(entry);
      if (real === entry) continue;
      restored[serverId] = withoutLatchEnv(real);
    }
    const ids = Object.keys(restored);
    if (ids.length === 0) {
      say(`nothing to unlink: no server in ${configPlace(config)} runs through latch`);
      continue;
    }
    if (options.dryRun) {
      say(`would restore ${plural(ids.length, "server")} in ${configPlace(config)}: ${printable(ids.join(", "))}`);
      continue;
    }
    try {
      await writeClientConfig({ ...config, servers: restored });
    } catch (error) {
      say(pc.red(`✖ could not rewrite ${configPlace(config)}: ${printable(error instanceof Error ? error.message : String(error))}`));
      code = 1;
      continue;
    }
    restoredClients.add(config.client);
    say(`${pc.green("✔")} restored ${plural(ids.length, "server")} in ${configPlace(config)}: ${printable(ids.join(", "))}`);
  }
  if (restoredClients.size > 0) {
    say(`next: restart ${listOf([...restoredClients].map((id) => CLIENT_NAMES[id]))}. latch.lock is kept, so linking again later keeps your approvals.`);
  }
  return code;
}
