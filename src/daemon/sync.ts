import { isDeepStrictEqual } from "node:util";
import { collectServers, pinServer, planRewrites, type InitServer, type SkippedServer } from "../commands/init.js";
import { INSTALL_LAUNCH, detectClients, writeClientConfig, type ClientId, type ConfigProblem, type ProxyLaunch } from "../config/clients.js";
import type { LockFile, Settings } from "../schema/index.js";
import { mergeServers, readLockfile, writeLockfile } from "../store/lockfile.js";
import { withStateLock } from "../store/pending.js";
import { clientEnabled } from "../store/settings.js";

export interface SyncOptions {
  lockfilePath: string;
  stateDir: string;
  /** Which clients to link (settings.clients); the rest are left alone. */
  settings: Settings;
  /** Who first-use pins are recorded as. */
  reviewer: string;
  /** How wrapped entries start latch. Defaults to INSTALL_LAUNCH. */
  launch?: ProxyLaunch;
  /** Deadline for capturing one server's tools. */
  timeoutMs?: number;
  now?: () => Date;
}

/** What one sync did. Nothing in it is an exception: a sync reports and carries on. */
export interface SyncResult {
  /** Client configs that exist but could not be read; left untouched. */
  problems: ConfigProblem[];
  /** Servers collectServers could not take (bad id, conflicting commands). */
  skipped: SkippedServer[];
  /** Servers pinned by this sync (trust on first use), with the tools held back for review. */
  pinned: Array<{ serverId: string; tools: string[]; held: Array<{ name: string; reason: string }> }>;
  /** Servers that could not be pinned (the server did not start or answer), or whose launch differs from latch.lock. */
  failed: Array<{ serverId: string; reason: string }>;
  /** Config files rewritten, with the servers wrapped (or re-wrapped) in each. */
  wrapped: Array<{ client: ClientId; path: string; scope?: string; serverIds: string[] }>;
}

/**
 * Brings every enabled client in line with latch.lock: each stdio server runs behind `latch proxy`
 * and is pinned. Run by `latch watch` (and the desktop app) whenever a client config changes.
 *
 * 1. Detects the client configs and collects their servers (collectServers), unwrapping any that
 *    already run latch, so a wrapped server and its original count as one.
 * 2. Pins every server latch.lock does not have yet (pinServer: trust on first use, tools with
 *    hidden-intent findings held back), without holding any lock: capturing takes seconds.
 * 3. Under the state lock, merges those pins into latch.lock as it is now (mergeServers): a pin or
 *    approval made meanwhile is never overwritten.
 * 4. Rewrites the client entries of servers whose launch matches latch.lock (planRewrites). That
 *    wraps new servers, re-wraps an entry the client turned back into the original, and repairs
 *    one that starts an old latch (a moved install), while an entry already right is not touched.
 *
 * Pinning comes before wrapping, so a wrapped server is always pinned and never blocked as
 * unpinned. Clients turned off in the settings, and non-stdio servers, are never touched.
 */
export async function syncClients(options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const launch = options.launch ?? INSTALL_LAUNCH;
  const detection = await detectClients();
  const configs = detection.configs.filter((config) => clientEnabled(options.settings, config.client));
  const problems = detection.problems.filter((problem) => clientEnabled(options.settings, problem.client));
  const { servers, skipped } = collectServers(configs);
  const result: SyncResult = { problems, skipped, pinned: [], failed: [], wrapped: [] };

  const lock = await readLockfile(options.lockfilePath);
  let pinnedLock: LockFile = lock;
  const newIds: string[] = [];
  for (const server of servers) {
    if (Object.hasOwn(lock.servers, server.serverId)) continue;
    try {
      const outcome = await pinServer(server, pinnedLock, options.reviewer, now(), options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
      pinnedLock = outcome.lock;
      newIds.push(server.serverId);
      result.pinned.push({ serverId: server.serverId, tools: outcome.pinned, held: outcome.held });
    } catch (error) {
      result.failed.push({ serverId: server.serverId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const current =
    newIds.length === 0
      ? lock
      : await withStateLock(options.stateDir, async () => {
          const merged = mergeServers(await readLockfile(options.lockfilePath), pinnedLock, newIds);
          if (merged.added.length > 0) await writeLockfile(options.lockfilePath, merged.lock);
          return merged.lock;
        });

  // Only servers latch.lock launches the way the client does: wrapping another would block every call.
  const ready: InitServer[] = [];
  for (const server of servers) {
    const pinned = Object.hasOwn(current.servers, server.serverId) ? current.servers[server.serverId]! : undefined;
    if (pinned === undefined) continue;
    if (pinned.transport === "stdio" && pinned.command === server.command && isDeepStrictEqual(pinned.args, server.args)) {
      ready.push(server);
    } else if (!result.failed.some((failure) => failure.serverId === server.serverId)) {
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
