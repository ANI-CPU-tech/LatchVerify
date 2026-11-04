import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import pc from "picocolors";
import {
  INSTALL_LAUNCH,
  SUPPORTED_CLIENTS,
  clientConfigPath,
  detectClients,
  findOldBackups,
  proxyLaunchOf,
  replacesLaunch,
  unwrapProxy,
  withoutLatchEnv,
  wrapWithProxy,
  writeClientConfig,
  type ClientConfig,
  type ClientId,
  type ClientServerEntry,
  type ProxyLaunch,
} from "../config/clients.js";
import type { LockFile } from "../schema/index.js";
import { programName } from "../analyze/hash.js";
import { launchesAs, linkServer, mergeServers, readLockfile, serializeLockfile, writeLockfile } from "../store/lockfile.js";
import { withStateLock } from "../store/pending.js";
import { configPlace, oldBackupWarning, plural, printable, problemWarning } from "./text.js";

export interface InitOptions {
  /** Restrict to one client; default is every detected client. */
  client?: ClientId;
  /** Print the planned config rewrites without writing anything. */
  dryRun: boolean;
  lockfilePath: string;
  /** State directory written into each wrapped entry's args. Defaults to .latch next to the lockfile. */
  stateDir?: string;
  /** Where progress is written. Defaults to process.stdout. */
  output?: Writable;
  /**
   * Ask which servers to wrap. Defaults to true when stdin and stdout are terminals and this is
   * not a dry run; otherwise every server is taken, so scripts and CI need no input.
   */
  interactive?: boolean;
  /** Where answers to the prompt come from. Defaults to process.stdin. */
  input?: Readable;
  /** How wrapped entries start latch. Defaults to INSTALL_LAUNCH (this install, by absolute path). */
  launch?: ProxyLaunch;
  /** Print the closing "next:" hints (commit latch.lock, restart the client). Defaults to true. */
  hints?: boolean;
}

/** One server latch init can wrap, as configured in one or more clients. */
export interface InitServer {
  serverId: string;
  /** The real server command and arguments (from after `--` when a config already wraps it). Never its env. */
  command: string;
  args: string[];
  /** Clients whose config has it, in detection order. */
  clients: ClientId[];
}

/** A configured server latch init leaves alone, and why. */
export interface SkippedServer {
  serverId: string;
  clients: ClientId[];
  reason: string;
}

/**
 * The stdio servers in `configs` that latch init can wrap, sorted by id, and the ones it must
 * skip. An entry that already runs `latch proxy` contributes its real command, so a second run
 * pins and wraps the same servers as the first.
 *
 * Skipped: an id `latch proxy --server` cannot take (empty or starting with "-"), a wrapped entry
 * whose real command cannot be recovered, and an id that clients configure with different
 * commands or arguments, since latch.lock holds one launch command per server id.
 */
export function collectServers(configs: readonly ClientConfig[]): { servers: InitServer[]; skipped: SkippedServer[] } {
  const groups = new Map<string, { server: InitServer; conflict: boolean }>();
  const skipped: SkippedServer[] = [];

  for (const config of configs) {
    for (const [serverId, entry] of Object.entries(config.servers)) {
      const real = unwrapProxy(entry);
      let wrapped: ClientServerEntry;
      try {
        wrapped = wrapWithProxy(serverId, real);
      } catch (error) {
        skipped.push({ serverId, clients: [config.client], reason: (error as Error).message });
        continue;
      }
      // wrapWithProxy returns its input unchanged only when it already runs latch proxy.
      if (wrapped === real) {
        skipped.push({ serverId, clients: [config.client], reason: "it runs latch proxy, but its real command cannot be recovered" });
        continue;
      }

      const args = real.args ?? [];
      const group = groups.get(serverId);
      if (group === undefined) {
        groups.set(serverId, {
          server: { serverId, command: real.command, args, clients: [config.client] },
          conflict: false,
        });
        continue;
      }
      if (!group.server.clients.includes(config.client)) group.server.clients.push(config.client);
      if (group.server.command !== real.command || JSON.stringify(group.server.args) !== JSON.stringify(args)) group.conflict = true;
    }
  }

  const servers: InitServer[] = [];
  for (const { server, conflict } of groups.values()) {
    if (conflict) {
      skipped.push({
        serverId: server.serverId,
        clients: server.clients,
        reason:
          server.clients.length === 1
            ? `${server.clients[0]} launches it with different commands in different places; give one of them another name`
            : `${listOf(server.clients)} launch it with different commands; give one of them another name`,
      });
    } else {
      servers.push(server);
    }
  }
  servers.sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0));
  return { servers, skipped };
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * `latch init`: put the MCP servers in this machine's client configs behind latch.
 *
 * 1. Reads latch.lock (a malformed one stops init before anything changes) and detects client
 *    configs, or only `client`'s.
 * 2. Collects their stdio servers (collectServers), asks which to wrap with a multiselect (all
 *    pre-selected; skipped when not interactive), and links each chosen server latch.lock does
 *    not have yet (linkServer): its launch is recorded and its tools are pinned by the proxy on
 *    the server's first run. Nothing is started here, so init never handles the keys in a
 *    client's config. A server already in latch.lock is left as pinned: changes to it go through
 *    `latch review`, never through a re-run of init.
 * 3. Writes latch.lock, then rewrites each client entry to run `latch proxy` (by absolute path,
 *    see INSTALL_LAUNCH) with --lockfile and --state-dir (`stateDir`, by default
 *    <lockfile dir>/.latch), so the proxy finds them whatever directory the client starts it in.
 *    Only the entry's command and args change; its env, which holds the server's keys, is never
 *    touched. The lockfile goes first: a config is only ever wrapped around a linked server.
 *
 * Running init again changes nothing. With `dryRun`, nothing is written.
 *
 * Resolves with 0 when every chosen server was handled (or none was chosen), 1 when no client
 * config was found, the prompt was cancelled, or any server was skipped or failed.
 *
 * @throws LockfileError when latch.lock exists but is malformed.
 */
export async function runInit(options: InitOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const lockfilePath = resolve(options.lockfilePath);
  const stateDir = resolve(options.stateDir ?? join(dirname(lockfilePath), ".latch"));
  const verb = (done: string, planned: string) => (options.dryRun ? planned : done);

  const lock = await readLockfile(lockfilePath);
  const detection = await detectClients();
  const wanted = (config: { client: ClientId }) => options.client === undefined || config.client === options.client;
  const configs = detection.configs.filter(wanted);
  const problems = detection.problems.filter(wanted);
  for (const problem of problems) say(pc.yellow(problemWarning(problem)));
  if (configs.length === 0) {
    say(pc.red(`✖ no usable MCP client config found${options.client === undefined ? "" : ` for ${options.client}`}. Looked in:`));
    for (const client of options.client === undefined ? SUPPORTED_CLIENTS : [options.client]) {
      say(`  ${client}: ${printable(clientConfigPath(client))}`);
    }
    return 1;
  }

  say(pc.bold(`latch init: ${printable(lockfilePath)}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));
  for (const config of configs) {
    say(`  found ${config.client}: ${configPlace(config)} (${plural(Object.keys(config.servers).length, "stdio server")})`);
  }
  const { servers, skipped } = collectServers(configs);
  // A config that could not be read keeps its servers unprotected: that is not a clean run.
  let failed = skipped.length > 0 || problems.length > 0;
  for (const skip of skipped) say(pc.yellow(`! skipping ${printable(skip.serverId)} (${skip.clients.join(", ")}): ${printable(skip.reason)}`));
  if (servers.length === 0) {
    say(failed ? pc.red("✖ no server can be wrapped") : "nothing to wrap: the configs have no stdio servers");
    return failed ? 1 : 0;
  }

  const interactive = options.interactive ?? (!options.dryRun && process.stdin.isTTY === true && process.stdout.isTTY === true);
  let chosen = servers;
  if (interactive) {
    say();
    // Loaded only for the prompt: the background sync shares this module and never asks anything.
    const { isCancel, multiselect } = await import("@clack/prompts");
    const picked = await multiselect({
      message: "Which servers should latch protect?",
      options: servers.map((server) => ({
        value: server.serverId,
        label: printable(server.serverId),
        hint: `${server.clients.join(", ")}: ${programOf(server.command)}${Object.hasOwn(lock.servers, server.serverId) ? " (already pinned)" : ""}`,
      })),
      initialValues: servers.map((server) => server.serverId),
      required: false,
      input: options.input ?? process.stdin,
      output: out,
    });
    if (isCancel(picked)) {
      say(pc.yellow("cancelled; nothing changed"));
      return 1;
    }
    chosen = servers.filter((server) => picked.includes(server.serverId));
    if (chosen.length === 0) {
      say("no server chosen; nothing changed");
      return failed ? 1 : 0;
    }
  }

  const now = new Date();
  let next = lock;
  const ready: InitServer[] = [];
  say();
  for (const server of chosen) {
    const id = printable(server.serverId);
    const existing = Object.hasOwn(next.servers, server.serverId) ? next.servers[server.serverId]! : undefined;
    if (existing !== undefined) {
      if (launchesAs(existing, server.command, server.args)) {
        say(`${pc.green("✔")} ${id}: already in latch.lock (${plural(existing.tools.length, "tool")}); changes go through \`latch review\``);
        ready.push(server);
      } else {
        say(pc.red(`✖ ${id}: the client starts it differently than latch.lock pinned it (${printable(existing.program)}, client: ${printable(programName(server.command))}); left unchanged`));
        failed = true;
      }
      continue;
    }
    // Nothing is started here: the proxy pins the tools on the server's first run, in the
    // process the client starts with the client's own env, so latch never handles those keys.
    next = linkServer(next, server.serverId, server.command, server.args, now);
    ready.push(server);
    say(`${pc.green("✔")} ${id}: ${verb("linked", "would link")}; its tools are pinned the first time ${listOf(server.clients)} ${server.clients.length === 1 ? "starts" : "start"} it`);
  }

  const rewrites = planRewrites(configs, ready, lockfilePath, stateDir, options.launch ?? INSTALL_LAUNCH);
  const lockChanged = serializeLockfile(next) !== serializeLockfile(lock);
  say();
  if (options.dryRun) {
    if (lockChanged) say(`would write ${printable(lockfilePath)} with ${plural(Object.keys(next.servers).length, "server")}`);
    for (const { config, servers: entries } of rewrites) {
      say(`would rewrite ${configPlace(config)}:`);
      for (const [serverId, entry] of Object.entries(entries)) {
        say(`  ${printable(serverId)}: ${programOf(unwrapProxy(entry).command)}, started through latch proxy`);
      }
    }
    if (!lockChanged && rewrites.length === 0) say("nothing to change");
    return failed ? 1 : 0;
  }

  if (lockChanged) {
    // Pinning took a while without the lock: merge into latch.lock as it is now, so an approval
    // or another pin made meanwhile is kept.
    const newIds = Object.keys(next.servers).filter((id) => !Object.hasOwn(lock.servers, id));
    await mkdir(dirname(lockfilePath), { recursive: true });
    const taken = await withStateLock(stateDir, async () => {
      const merged = mergeServers(await readLockfile(lockfilePath), next, newIds);
      if (merged.added.length > 0) await writeLockfile(lockfilePath, merged.lock);
      return merged.taken;
    });
    say(`${pc.green("✔")} wrote ${printable(lockfilePath)}`);
    for (const id of taken) say(pc.yellow(`! ${printable(id)} was added to latch.lock by someone else meanwhile; that pin is kept`));
  }
  for (const { config, servers: entries } of rewrites) {
    try {
      await writeClientConfig({ ...config, servers: entries });
      say(`${pc.green("✔")} wrapped ${plural(Object.keys(entries).length, "server")} in ${configPlace(config)}`);
    } catch (error) {
      say(pc.red(`✖ could not rewrite ${configPlace(config)}: ${printable(error instanceof Error ? error.message : String(error))}`));
      failed = true;
    }
  }
  if (!lockChanged && rewrites.length === 0) say("nothing to change");

  // setup (hints off) gives this warning itself.
  if (options.hints !== false) for (const line of oldBackupWarning(await findOldBackups())) say(pc.yellow(line));
  if (options.hints !== false) {
    if (lockChanged) say(`next: commit ${printable(lockfilePath)} so the pins are reviewed like code`);
    if (rewrites.length > 0) say(`next: restart ${[...new Set(rewrites.map((r) => r.config.client))].join(", ")} to start the wrapped servers`);
  }
  return failed ? 1 : 0;
}

/**
 * `entry` wrapped with `latch proxy` (wrapWithProxy) with --lockfile and --state-dir, so the proxy
 * finds this lockfile whatever directory the client starts it in. The entry's env is the user's
 * (it holds the server's keys) and is left as it is, except that LATCH_LOCKFILE_PATH and
 * LATCH_STATE_DIR, which older versions put there, are taken out.
 */
export function proxiedEntry(
  serverId: string,
  entry: ClientServerEntry,
  lockfilePath: string,
  stateDir: string,
  launch: ProxyLaunch,
): ClientServerEntry {
  return withoutLatchEnv(wrapWithProxy(serverId, entry, launch, { lockfilePath, stateDir }));
}

/**
 * Per client config, the entries to write: each ready server it configures, as proxiedEntry.
 * Entries already in that state are left out, and configs with nothing left are dropped, which
 * makes a second init a no-op.
 *
 * Every target is built from the entry's original command (unwrapProxy), so an entry written by
 * an older version (paths in env, no node flags) is brought up to date. An entry that already runs
 * latch keeps its own launch unless replacesLaunch says it must give way to `launch`: an entry of
 * this install gains the current node flags, and one of a moved or removed install starts again.
 */
export function planRewrites(
  configs: readonly ClientConfig[],
  ready: readonly InitServer[],
  lockfilePath: string,
  stateDir: string,
  launch: ProxyLaunch,
): Array<{ config: ClientConfig; servers: Record<string, ClientServerEntry> }> {
  return configs.flatMap((config) => {
    const entries: Array<[string, ClientServerEntry]> = [];
    for (const server of ready) {
      // Per file, not per client: a client can keep servers in more than one file.
      if (!Object.hasOwn(config.servers, server.serverId)) continue;
      const current = config.servers[server.serverId]!;
      const own = proxyLaunchOf(current);
      const keep = own !== undefined && !replacesLaunch(own, launch) ? own : launch;
      const target = proxiedEntry(server.serverId, unwrapProxy(current), lockfilePath, stateDir, keep);
      if (!isDeepStrictEqual(target, current)) entries.push([server.serverId, target]);
    }
    return entries.length > 0 ? [{ config, servers: Object.fromEntries(entries) }] : [];
  });
}

/**
 * How a server is named in messages: its program only ("npx"), never the rest of its launch line,
 * whose arguments may hold a key (`--token ...`).
 */
export function programOf(command: string): string {
  return printable(programName(command));
}
