import { unwrapProxy, wrapWithProxy, type ClientConfig, type ClientId, type ClientServerEntry } from "../config/clients.js";

export interface InitOptions {
  /** Restrict to one client; default is every detected client. */
  client?: ClientId;
  /** Print the planned config rewrites without writing anything. */
  dryRun: boolean;
  lockfilePath: string;
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
 * `latch init`
 * TODO: detectClients(), let the user pick servers with @clack/prompts multiselect, rewrite each
 * chosen entry with wrapWithProxy() (backing up the original config), capture each server's
 * tools/list once, and write an initial latch.lock with every tool pinned under the current git
 * user. Resolves with the process exit code.
 */
export async function runInit(options: InitOptions): Promise<number> {
  throw new Error("not implemented");
}
