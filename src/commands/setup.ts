import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import pc from "picocolors";
import { clientConfigPath, detectClients, findOldBackups, unwrapProxy, withoutLatchEnv, writeClientConfig, type ClientId, type ClientServerEntry, type ProxyLaunch } from "../config/clients.js";
import { emptyLockfile, writeLockfile } from "../store/lockfile.js";
import { readSettings, settingsPath, updateSettings } from "../store/settings.js";
import { CLIENT_NAMES } from "../config/client-names.js";
import { runInit } from "./init.js";
import { configPlace, oldBackupWarning, plural, printable, problemWarning } from "./text.js";

export { CLIENT_NAMES };

export interface SetupOptions {
  /** The client to link (--client), or undefined for every client found (--all). Naming it is the user's consent. */
  client: ClientId | undefined;
  /** settings.json, where the consent is recorded. Defaults to the one beside the per-user lockfile. */
  settingsPath?: string;
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
 * `latch setup --client <id>` or `latch setup --all`: link that client, or every client found, to
 * latch with no questions. Naming the clients is the user's consent, recorded in settings.json
 * (clients[id] = true), so the background sync keeps them linked, new servers included. Plain
 * `latch setup` asks first (runSetupAsk).
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

  // Consent: the clients linked here stay linked by the background sync.
  if (!options.dryRun && linked.length > 0) {
    await updateSettings(options.settingsPath ?? settingsPath(), { clients: Object.fromEntries(linked.map((id) => [id, true])) });
  }

  for (const line of oldBackupWarning(await findOldBackups())) say(pc.yellow(line));

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
  /** settings.json, where the choice is recorded (clients[id] = false). Defaults to the one beside the per-user lockfile. */
  settingsPath?: string;
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
  // Unlinking is a no: the background sync leaves these clients alone from now on.
  if (!options.dryRun) {
    const declined = client === undefined ? [...new Set([...detection.configs, ...detection.problems].map((found) => found.client))] : [client];
    if (declined.length > 0) await updateSettings(options.settingsPath ?? settingsPath(), { clients: Object.fromEntries(declined.map((id) => [id, false])) });
  }
  if (restoredClients.size > 0) {
    say(`next: restart ${listOf([...restoredClients].map((id) => CLIENT_NAMES[id]))}. latch.lock is kept, so linking again later keeps your approvals.`);
  }
  return code;
}

export interface SetupAskOptions extends Omit<SetupOptions, "client"> {
  /** Ask with a prompt. Defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
  input?: Readable;
}

/**
 * Plain `latch setup`: find the MCP clients on this machine and ask which to connect. Only names
 * are shown: the client, its config file and how many servers it has, never a server's launch
 * line or env. Each client chosen is linked (runSetup) and recorded as connected.
 *
 * Without a terminal (an installer, a script) nothing is linked: setup lists what it found and
 * how to connect, and creates the per-user lockfile. Resolves 1 when a chosen client failed.
 */
export async function runSetupAsk(options: SetupAskOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const detection = await detectClients();
  const found = new Map<ClientId, { files: Set<string>; servers: number }>();
  for (const config of detection.configs) {
    const entry = found.get(config.client) ?? { files: new Set<string>(), servers: 0 };
    entry.files.add(config.path);
    entry.servers += Object.keys(config.servers).length;
    found.set(config.client, entry);
  }
  for (const problem of detection.problems) say(pc.yellow(problemWarning(problem)));
  const settings = await readSettings(options.settingsPath ?? settingsPath());

  say(pc.bold("latch setup: MCP clients on this machine"));
  if (found.size === 0) say("  none found yet. After installing an MCP client, run `latch setup` again.");
  for (const [id, { files, servers }] of found) {
    const state = settings.clients[id] === true ? pc.green("connected") : settings.clients[id] === false ? pc.dim("not connected (you said no)") : pc.yellow("not connected yet");
    say(`  ${CLIENT_NAMES[id].padEnd(20)} ${plural(servers, "server").padEnd(11)} ${state}  ${printable([...files].join(", "))}`);
  }

  const candidates = [...found.keys()].filter((id) => settings.clients[id] !== true);
  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (candidates.length === 0 || !interactive) {
    if (candidates.length > 0) {
      say();
      say("Nothing was changed. LatchVerify connects a client only when you say so:");
      say("  latch setup                    choose in a terminal");
      say("  latch setup --client <id>      connect one: " + candidates.join(", "));
      say("  latch setup --all              connect every client found");
    }
    if (!existsSync(options.lockfilePath) && !options.dryRun) {
      await mkdir(dirname(resolve(options.lockfilePath)), { recursive: true });
      await writeLockfile(resolve(options.lockfilePath), emptyLockfile());
    }
    return 0;
  }

  // Loaded only for the prompt.
  const { isCancel, multiselect } = await import("@clack/prompts");
  say();
  const picked = await multiselect({
    message: "Which clients should LatchVerify connect? Their servers start behind the proxy, and their tools are pinned on first run.",
    options: candidates.map((id) => ({ value: id, label: CLIENT_NAMES[id], hint: plural(found.get(id)!.servers, "server") })),
    initialValues: [],
    required: false,
    input: options.input ?? process.stdin,
    output: out,
  });
  if (isCancel(picked) || picked.length === 0) {
    say("nothing connected");
    return 0;
  }
  let code = 0;
  for (const client of picked) code = Math.max(code, await runSetup({ ...options, client }));
  return code;
}
