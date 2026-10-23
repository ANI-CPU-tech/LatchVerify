import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import pc from "picocolors";
import {
  PROXY_COMMAND,
  SUPPORTED_CLIENTS,
  clientConfigPath,
  detectClients,
  unwrapProxy,
  wrapWithProxy,
  writeClientConfig,
  type ClientConfig,
  type ClientId,
  type ClientServerEntry,
} from "../config/clients.js";
import { analyzeToolList } from "../proxy/analysis.js";
import { captureTools } from "../proxy/capture.js";
import type { LockFile } from "../schema/index.js";
import { applyApproval, readLockfile, serializeLockfile, writeLockfile } from "../store/lockfile.js";
import { defaultReviewer } from "../ui/server.js";
import { plural, printable } from "./text.js";

export interface InitOptions {
  /** Restrict to one client; default is every detected client. */
  client?: ClientId;
  /** Print the planned config rewrites without writing anything. */
  dryRun: boolean;
  lockfilePath: string;
  /** Who the pins are recorded as. Defaults to defaultReviewer(): LATCH_REVIEWER, git user.email, OS user. */
  reviewer?: string;
  /** Deadline for capturing each server's tools. Defaults to DEFAULT_CAPTURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Where progress is written. Defaults to process.stdout. */
  output?: Writable;
}

/** One server latch init can wrap, as configured in one or more clients. */
export interface InitServer {
  serverId: string;
  /** The real server command and arguments (from after `--` when a config already wraps it). */
  command: string;
  args: string[];
  /** The entry's env as strings. VS Code allows numbers too, and null to unset a variable. */
  env: Record<string, string>;
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
          server: { serverId, command: real.command, args, env: stringEnv(real.env), clients: [config.client] },
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
        reason: `${listOf(server.clients)} launch it with different commands; give one of them another name`,
      });
    } else {
      servers.push(server);
    }
  }
  servers.sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0));
  return { servers, skipped };
}

/** A server's tools pinned in latch init. */
export interface PinOutcome {
  /** A new lockfile with the server added and its tools pinned. */
  lock: LockFile;
  /** Tools pinned, in list order. */
  pinned: string[];
  /** Tools left unpinned because of critical findings, with the reason. */
  held: Array<{ name: string; reason: string }>;
  /** Protocol version the server answered with. */
  specVersion: string | null;
}

/**
 * Capture `server`'s tools and pin them, under `reviewer` at `now`, in a copy of `lock` that
 * also gains the server's launch command. `lock` is not modified.
 *
 * Trust on first use stops at hidden intent: a tool with a critical finding (hidden
 * instructions, invisible or bidi characters, a reference to another server's tool, a
 * definition that cannot be analyzed) is held back. The proxy then queues it as a tier-3 change
 * for `latch review` instead of trusting it silently. Capabilities alone never hold a tool back:
 * a server installed to run commands may run commands.
 *
 * @throws Error when the server is already in `lock`, or CaptureError when its tools cannot be
 * captured.
 */
export async function pinServer(
  server: InitServer,
  lock: LockFile,
  reviewer: string,
  now: Date,
  options: { timeoutMs?: number } = {},
): Promise<PinOutcome> {
  const { serverId } = server;
  if (Object.hasOwn(lock.servers, serverId)) throw new Error(`server "${serverId}" is already in latch.lock`);
  const captured = await captureTools(server.command, server.args, { env: server.env, ...options });

  let next: LockFile = {
    ...lock,
    generatedAt: now.toISOString(),
    servers: { ...lock.servers, [serverId]: { transport: "stdio", command: server.command, args: server.args, tools: [] } },
  };
  const analysis = analyzeToolList(serverId, { tools: captured.tools }, next, captured.specVersion, now)!;
  const pinned: string[] = [];
  const held: PinOutcome["held"] = [];
  for (const { change, reason } of analysis.changes) {
    if (change.findings.some((finding) => finding.severity === "critical")) {
      held.push({ name: change.toolName, reason });
      continue;
    }
    next = applyApproval(next, change, reviewer, now);
    pinned.push(change.toolName);
  }
  return { lock: next, pinned, held, specVersion: captured.specVersion };
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** An entry's env as strings: numbers and booleans converted, null and other values dropped. */
function stringEnv(env: unknown): Record<string, string> {
  if (typeof env !== "object" || env === null) return {};
  // fromEntries keeps a "__proto__" variable as a plain key.
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]): Array<[string, string]> =>
      typeof value === "string" ? [[key, value]] : typeof value === "number" || typeof value === "boolean" ? [[key, String(value)]] : [],
    ),
  );
}

/**
 * `latch init`: put the MCP servers in this machine's client configs behind latch.
 *
 * 1. Reads latch.lock (a malformed one stops init before anything changes) and detects client
 *    configs, or only `client`'s.
 * 2. Collects their stdio servers (collectServers) and pins each server latch.lock does not have
 *    yet (pinServer), under the reviewer. A server already in latch.lock is left as pinned:
 *    changes to it go through `latch review`, never through a re-run of init.
 * 3. Writes latch.lock, then rewrites each client entry to run `latch proxy`, with
 *    LATCH_LOCKFILE_PATH and LATCH_STATE_DIR in its env so the proxy finds this lockfile and
 *    <lockfile dir>/.latch whatever directory the client starts it in. Each rewritten config
 *    keeps a timestamped .bak copy. The lockfile goes first: a config is only ever wrapped
 *    around pins that exist.
 *
 * A server whose tools cannot be captured is reported and neither pinned nor wrapped. Running
 * init again changes nothing. With `dryRun`, servers are still queried to show what would be
 * pinned, but nothing is written.
 *
 * Resolves with 0 when every server was handled, 1 when no client config was found or any
 * server was skipped or failed.
 *
 * @throws LockfileError when latch.lock exists but is malformed.
 */
export async function runInit(options: InitOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const lockfilePath = resolve(options.lockfilePath);
  const stateDir = join(dirname(lockfilePath), ".latch");
  const verb = (done: string, planned: string) => (options.dryRun ? planned : done);

  const lock = await readLockfile(lockfilePath);
  const configs = (await detectClients()).filter((config) => options.client === undefined || config.client === options.client);
  if (configs.length === 0) {
    say(pc.red(`✖ no MCP client config found${options.client === undefined ? "" : ` for ${options.client}`}. Looked in:`));
    for (const client of options.client === undefined ? SUPPORTED_CLIENTS : [options.client]) {
      say(`  ${client}: ${printable(clientConfigPath(client))}`);
    }
    return 1;
  }

  say(pc.bold(`latch init: ${printable(lockfilePath)}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));
  for (const config of configs) {
    say(`  found ${config.client}: ${printable(config.path)} (${plural(Object.keys(config.servers).length, "stdio server")})`);
  }
  const { servers, skipped } = collectServers(configs);
  let failed = skipped.length > 0;
  for (const skip of skipped) say(pc.yellow(`! skipping ${printable(skip.serverId)} (${skip.clients.join(", ")}): ${printable(skip.reason)}`));
  if (servers.length === 0) {
    say(failed ? pc.red("✖ no server can be wrapped") : "nothing to wrap: the configs have no stdio servers");
    return failed ? 1 : 0;
  }

  const reviewer = options.reviewer ?? defaultReviewer();
  const now = new Date();
  let next = lock;
  const ready: InitServer[] = [];
  say();
  for (const server of servers) {
    const id = printable(server.serverId);
    const existing = Object.hasOwn(next.servers, server.serverId) ? next.servers[server.serverId]! : undefined;
    if (existing !== undefined) {
      if (existing.transport === "stdio" && existing.command === server.command && isDeepStrictEqual(existing.args, server.args)) {
        say(`${pc.green("✔")} ${id}: already in latch.lock (${plural(existing.tools.length, "tool")}); changes go through \`latch review\``);
        ready.push(server);
      } else {
        say(pc.red(`✖ ${id}: latch.lock launches it as ${commandLine(existing.command, existing.args)}, but the client runs ${commandLine(server.command, server.args)}; left unchanged`));
        failed = true;
      }
      continue;
    }
    try {
      const outcome = await pinServer(server, next, reviewer, now, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
      next = outcome.lock;
      ready.push(server);
      const names = outcome.pinned.length > 0 ? `: ${printable(outcome.pinned.join(", "))}` : "";
      say(`${pc.green("✔")} ${id}: ${verb("pinned", "would pin")} ${plural(outcome.pinned.length, "tool")}${names}`);
      for (const held of outcome.held) {
        say(pc.yellow(`  ! ${printable(held.name)} ${verb("held back", "would be held back")} for \`latch review\`: ${printable(held.reason)}`));
      }
    } catch (error) {
      say(pc.red(`✖ ${id}: ${printable(error instanceof Error ? error.message : String(error))}; not pinned or wrapped`));
      failed = true;
    }
  }

  const rewrites = planRewrites(configs, ready, lockfilePath, stateDir);
  const lockChanged = serializeLockfile(next) !== serializeLockfile(lock);
  say();
  if (options.dryRun) {
    if (lockChanged) say(`would write ${printable(lockfilePath)} with ${plural(Object.keys(next.servers).length, "server")}`);
    for (const { config, servers: entries } of rewrites) {
      say(`would rewrite ${printable(config.path)}, keeping a .bak copy:`);
      for (const [serverId, entry] of Object.entries(entries)) {
        say(`  ${printable(serverId)}: ${commandLine(entry.command, entry.args ?? [])}`);
      }
    }
    if (!lockChanged && rewrites.length === 0) say("nothing to change");
    return failed ? 1 : 0;
  }

  if (lockChanged) {
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, next);
    say(`${pc.green("✔")} wrote ${printable(lockfilePath)}`);
  }
  for (const { config, servers: entries } of rewrites) {
    try {
      await writeClientConfig({ ...config, servers: entries });
      say(`${pc.green("✔")} wrapped ${plural(Object.keys(entries).length, "server")} in ${printable(config.path)} (the original is kept as a .bak copy)`);
    } catch (error) {
      say(pc.red(`✖ could not rewrite ${printable(config.path)}: ${printable(error instanceof Error ? error.message : String(error))}`));
      failed = true;
    }
  }
  if (!lockChanged && rewrites.length === 0) say("nothing to change");

  if (rewrites.length > 0 && !onPath(PROXY_COMMAND)) {
    say(pc.yellow(`! \`${PROXY_COMMAND}\` is not on PATH, so clients cannot start the wrapped servers; run \`pnpm link --global\` in the latchverify checkout`));
  }
  if (lockChanged) say(`next: commit ${printable(lockfilePath)} so the pins are reviewed like code`);
  if (rewrites.length > 0) say(`next: restart ${[...new Set(rewrites.map((r) => r.config.client))].join(", ")} to start the wrapped servers`);
  return failed ? 1 : 0;
}

/**
 * Per client config, the entries to write: each ready server it configures, wrapped with
 * `latch proxy` and given LATCH_LOCKFILE_PATH and LATCH_STATE_DIR. Entries already in that state
 * are left out, and configs with nothing left are dropped, which makes a second init a no-op.
 */
function planRewrites(
  configs: readonly ClientConfig[],
  ready: readonly InitServer[],
  lockfilePath: string,
  stateDir: string,
): Array<{ config: ClientConfig; servers: Record<string, ClientServerEntry> }> {
  return configs.flatMap((config) => {
    const entries: Array<[string, ClientServerEntry]> = [];
    for (const server of ready) {
      if (!server.clients.includes(config.client)) continue;
      const current = config.servers[server.serverId]!;
      const wrapped = wrapWithProxy(server.serverId, current);
      const env = typeof wrapped.env === "object" && wrapped.env !== null ? wrapped.env : {};
      const target: ClientServerEntry = { ...wrapped, env: { ...env, LATCH_LOCKFILE_PATH: lockfilePath, LATCH_STATE_DIR: stateDir } };
      if (!isDeepStrictEqual(target, current)) entries.push([server.serverId, target]);
    }
    return entries.length > 0 ? [{ config, servers: Object.fromEntries(entries) }] : [];
  });
}

function commandLine(command: string, args: readonly string[]): string {
  return printable([command, ...args].join(" "));
}

/** True when an executable named `command` is in a PATH directory. */
function onPath(command: string): boolean {
  const names = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => names.some((name) => existsSync(join(dir, name))));
}
