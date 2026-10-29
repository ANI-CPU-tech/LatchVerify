import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import {
  INSTALL_LAUNCH,
  clientLocations,
  detectClients,
  writeClientConfig,
  valueAt,
  type ClientConfig,
  type ClientId,
  type ClientServerEntry,
  type ProxyLaunch,
} from "../config/clients.js";
import { mergeServers, readLockfile, writeLockfile } from "../store/lockfile.js";
import { withStateLock } from "../store/pending.js";
import { defaultReviewer } from "../ui/server.js";
import { commandLine, pinServer, proxiedEntry } from "./init.js";
import { plural, printable } from "./text.js";

export interface AddOptions {
  /** Server id: the key in the client config and in latch.lock. */
  name: string;
  /** The real server command and its arguments. */
  command: string[];
  /** Client whose config gets the server. */
  client: ClientId;
  /** `KEY=VALUE` sets a variable; a bare `KEY` copies it from `sourceEnv`. */
  env: string[];
  /** Capture and report, but write nothing. */
  dryRun: boolean;
  lockfilePath: string;
  /** State directory written into the entry's env. Defaults to .latch next to the lockfile. */
  stateDir?: string;
  /** Who the pins are recorded as. Defaults to defaultReviewer(). */
  reviewer?: string;
  /** Deadline for capturing the server's tools. Defaults to DEFAULT_CAPTURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Where progress is written. Defaults to process.stdout. */
  output?: Writable;
  /** How the entry starts latch. Defaults to INSTALL_LAUNCH. */
  launch?: ProxyLaunch;
  /** Where a bare `--env KEY` reads its value. Defaults to process.env. */
  sourceEnv?: NodeJS.ProcessEnv;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The server's env from `--env` values. A bare KEY copies the value from `source`, so a token can
 * come from the shell's environment instead of the command line (and shell history).
 *
 * @throws Error naming the variable when a name is invalid or a bare KEY is not set.
 */
export function parseEnv(values: readonly string[], source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator === -1 ? value : value.slice(0, separator);
    if (!ENV_NAME.test(key)) throw new Error(`--env ${JSON.stringify(value)}: expected KEY or KEY=VALUE`);
    const resolved = separator === -1 ? source[key] : value.slice(separator + 1);
    if (resolved === undefined) throw new Error(`--env ${key}: ${key} is not set in this shell; export it first or pass ${key}=VALUE`);
    // defineProperty: a variable named "__proto__" stays plain data.
    Object.defineProperty(env, key, { value: resolved, enumerable: true, writable: true, configurable: true });
  }
  return env;
}

/**
 * `latch add`: put one MCP server behind latch, in one client.
 *
 * 1. Reads latch.lock and the client's config. Refuses, writing nothing, when the name is already
 *    in either: an existing server is never overwritten, and changes to a pinned one go through
 *    `latch review`.
 * 2. Starts the server and pins its tools (pinServer, the same trust on first use as `latch
 *    init`: tools with critical findings are held back for review).
 * 3. Writes latch.lock, then adds the server to the client config, wrapped with `latch proxy`
 *    by absolute path (proxiedEntry). The config keeps a timestamped .bak copy and every other
 *    server and key. Env values are written to the config but never printed.
 *
 * Resolves with 0 on success (or a dry run that would succeed), 1 when refused or the server's
 * tools cannot be captured.
 *
 * @throws LockfileError when latch.lock exists but is malformed.
 */
export async function runAdd(options: AddOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const fail = (message: string) => (say(pc.red(`✖ ${printable(message)}`)), 1);
  const lockfilePath = resolve(options.lockfilePath);
  const stateDir = resolve(options.stateDir ?? join(dirname(lockfilePath), ".latch"));
  const launch = options.launch ?? INSTALL_LAUNCH;
  const { name, client } = options;
  const [command, ...args] = options.command;
  if (command === undefined || command === "") return fail("no server command given; put it after --");

  let env: Record<string, string>;
  let entry: ClientServerEntry;
  try {
    env = parseEnv(options.env, options.sourceEnv ?? process.env);
    // Built before the server starts, so an id the proxy cannot take fails without spawning anything.
    entry = proxiedEntry(name, { command, args, ...(Object.keys(env).length > 0 ? { env } : {}) }, lockfilePath, stateDir, launch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const lock = await readLockfile(lockfilePath);
  const detection = await detectClients();
  const problem = detection.problems.find((found) => found.client === client);
  if (problem !== undefined) return fail(`${problem.path} ${problem.message}; fix it before adding a server to it`);
  const detected = detection.configs.find((found) => found.client === client);
  const config: ClientConfig = detected ?? { client, ...clientLocations(client)[0]!, servers: {}, raw: {} };
  say(pc.bold(`latch add ${printable(name)}: ${printable(lockfilePath)}${options.dryRun ? pc.yellow(" (dry run: nothing is written)") : ""}`));
  // The raw map, not config.servers: an HTTP server of that name must not be replaced either.
  const existing = valueAt(config.raw, config.serversPath);
  if (typeof existing === "object" && existing !== null && Object.hasOwn(existing, name)) {
    return fail(`${name} is already in ${config.path}; pick another name, or remove it there first`);
  }
  if (Object.hasOwn(lock.servers, name)) {
    return fail(`${name} is already in latch.lock; changes to a pinned server go through \`latch review\``);
  }

  say(`  starting ${commandLine(command, args)} to read its tools`);
  let outcome;
  try {
    outcome = await pinServer(
      { serverId: name, command, args, env, clients: [client] },
      lock,
      options.reviewer ?? defaultReviewer(),
      new Date(),
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    return fail(`${name}: ${error instanceof Error ? error.message : String(error)}; nothing written`);
  }

  const verb = (done: string, planned: string) => (options.dryRun ? planned : done);
  const names = outcome.pinned.length > 0 ? `: ${printable(outcome.pinned.join(", "))}` : "";
  say(`${pc.green("✔")} ${printable(name)}: ${verb("pinned", "would pin")} ${plural(outcome.pinned.length, "tool")}${names}`);
  for (const held of outcome.held) {
    say(pc.yellow(`  ! ${printable(held.name)} ${verb("held back", "would be held back")} for \`latch review\`: ${printable(held.reason)}`));
  }
  if (options.dryRun) {
    say(`would write ${printable(lockfilePath)} and add ${printable(name)} to ${printable(config.path)}:`);
    say(`  ${commandLine(entry.command, entry.args ?? [])}`);
    return 0;
  }

  // The lockfile goes first: a config is only ever wrapped around pins that exist.
  await mkdir(dirname(lockfilePath), { recursive: true });
  // Merged into latch.lock as it is now: an approval made while the server was queried is kept.
  const taken = await withStateLock(stateDir, async () => {
    const merged = mergeServers(await readLockfile(lockfilePath), outcome.lock, [name]);
    if (merged.added.length > 0) await writeLockfile(lockfilePath, merged.lock);
    return merged.taken.length > 0;
  });
  if (taken) return fail(`${name} was added to latch.lock by someone else meanwhile; nothing else written`);
  say(`${pc.green("✔")} wrote ${printable(lockfilePath)}`);
  try {
    await writeClientConfig({ ...config, servers: { [name]: entry } });
  } catch (error) {
    return fail(`could not add ${name} to ${config.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  say(`${pc.green("✔")} added ${printable(name)} to ${printable(config.path)}${detected === undefined ? "" : " (the original is kept as a .bak copy)"}`);
  say(`next: commit ${printable(lockfilePath)} so the pins are reviewed like code`);
  say(`next: restart ${client} to start ${printable(name)}`);
  return 0;
}
