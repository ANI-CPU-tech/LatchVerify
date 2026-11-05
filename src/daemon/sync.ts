import { isDeepStrictEqual } from "node:util";
import { collectServers, planRewrites, type InitServer, type SkippedServer } from "../commands/init.js";
import { INSTALL_LAUNCH, detectClients, writeClientConfig, type ClientId, type ConfigProblem, type ProxyLaunch } from "../config/clients.js";
import type { LockFile, Settings } from "../schema/index.js";
import { launchesAs, linkServer, mergeServers, readLockfile, writeLockfile } from "../store/lockfile.js";
import { withStateLock } from "../store/pending.js";
import { clientConnected } from "../store/settings.js";

export interface SyncOptions {
  lockfilePath: string;
  stateDir: string;
  /** Which clients to link (settings.clients); the rest are left alone. */
  settings: Settings;
  /** How wrapped entries start latch. Defaults to INSTALL_LAUNCH. */
  launch?: ProxyLaunch;
  now?: () => Date;
}

/** What one sync did. Nothing in it is an exception: a sync reports and carries on. */
export interface SyncResult {
  /** Client configs that exist but could not be read; left untouched. */
  problems: ConfigProblem[];
  /** Servers collectServers could not take (bad id, conflicting commands). */
  skipped: SkippedServer[];
  /** Servers this sync added to latch.lock, to be pinned on their first run (linkServer). */
  linked: string[];
  /** Servers whose launch differs from latch.lock: left unwrapped. */
  failed: Array<{ serverId: string; reason: string }>;
  /** Config files rewritten, with the servers wrapped (or re-wrapped) in each. */
  wrapped: Array<{ client: ClientId; path: string; scope?: string; serverIds: string[] }>;
  /** Clients found that the user was never asked about, with their stdio server count: left alone. */
  unasked: Array<{ client: ClientId; servers: number }>;
}

/**
 * Brings every connected client in line with latch.lock, whenever a client config changes: links
 * servers latch.lock does not have (pinned on their first run, inside the process the client starts
 * with its own env, so the sync never reads or uses a client's keys), merges them under the state
 * lock so a pin or approval made meanwhile is kept, then wraps new servers, re-wraps entries a
 * client turned back, and repairs those of a moved install. Linking comes before wrapping. A client
 * never asked about is only reported in `unasked`; non-stdio servers are never touched.
 */
export async function syncClients(options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const launch = options.launch ?? INSTALL_LAUNCH;
  const detection = await detectClients();
  const configs = detection.configs.filter((config) => clientConnected(options.settings, config.client));
  const problems = detection.problems.filter((problem) => clientConnected(options.settings, problem.client));
  const unasked = new Map<ClientId, number>();
  for (const config of detection.configs) {
    if (options.settings.clients[config.client] !== undefined) continue;
    unasked.set(config.client, (unasked.get(config.client) ?? 0) + Object.keys(config.servers).length);
  }
  const { servers, skipped } = collectServers(configs);
  const result: SyncResult = { problems, skipped, linked: [], failed: [], wrapped: [], unasked: [...unasked].map(([client, servers]) => ({ client, servers })) };

  const lock = await readLockfile(options.lockfilePath);
  let linkedLock: LockFile = lock;
  const newIds: string[] = [];
  for (const server of servers) {
    if (Object.hasOwn(lock.servers, server.serverId)) continue;
    linkedLock = linkServer(linkedLock, server.serverId, server.command, server.args, now());
    newIds.push(server.serverId);
  }

  const current =
    newIds.length === 0
      ? lock
      : await withStateLock(options.stateDir, async () => {
          const merged = mergeServers(await readLockfile(options.lockfilePath), linkedLock, newIds);
          if (merged.added.length > 0) await writeLockfile(options.lockfilePath, merged.lock);
          result.linked = merged.added;
          return merged.lock;
        });

  // Only servers latch.lock launches the way the client does: wrapping another would block every call.
  const ready: InitServer[] = [];
  for (const server of servers) {
    const pinned = Object.hasOwn(current.servers, server.serverId) ? current.servers[server.serverId]! : undefined;
    if (pinned === undefined) continue;
    if (launchesAs(pinned, server.command, server.args)) {
      ready.push(server);
    } else {
      result.failed.push({ serverId: server.serverId, reason: "latch.lock launches it with another command than the client does; left unwrapped" });
    }
  }

  for (const { config, servers: entries } of planRewrites(configs, ready, options.lockfilePath, options.stateDir, launch)) {
    try {
      await writeClientConfig({ ...config, servers: entries });
      result.wrapped.push({ client: config.client, path: config.path, ...(config.scope === undefined ? {} : { scope: config.scope }), serverIds: Object.keys(entries) });
    } catch (error) {
      result.problems.push({ client: config.client, path: config.path, message: `could not be rewritten: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}
