import { homedir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";

/** MCP clients whose config files `latch init` knows how to rewrite. */
export const SUPPORTED_CLIENTS = ["claude-desktop", "claude-code", "cursor", "vscode"] as const;
export type ClientId = (typeof SUPPORTED_CLIENTS)[number];

/** One `mcpServers` entry as clients store it on disk. */
export interface ClientServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [extra: string]: unknown;
}

/** A client config file located on this machine. */
export interface ClientConfig {
  client: ClientId;
  path: string;
  servers: Record<string, ClientServerEntry>;
  /** The full parsed file, so unrelated keys are written back untouched. */
  raw: Record<string, unknown>;
}

/**
 * Where a client keeps its user-level MCP server config on `platform`. Returns an absolute path.
 *
 * | Client         | macOS / Windows / Linux                                                          |
 * |----------------|----------------------------------------------------------------------------------|
 * | claude-desktop | <app data>/Claude/claude_desktop_config.json                                     |
 * | claude-code    | ~/.claude.json                                                                   |
 * | cursor         | ~/.cursor/mcp.json                                                               |
 * | vscode         | <app data>/Code/User/mcp.json (the default profile's user MCP config)            |
 *
 * <app data> is ~/Library/Application Support on macOS, %APPDATA% on Windows (falling back to
 * ~/AppData/Roaming), and $XDG_CONFIG_HOME or ~/.config elsewhere, which is where Electron apps
 * keep it. ~ is os.homedir(), so HOME (USERPROFILE on Windows) redirects every path.
 */
export function clientConfigPath(client: ClientId, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  const home = homedir();
  const appData = (): string => {
    if (platform === "darwin") return path.join(home, "Library", "Application Support");
    if (platform === "win32") return absoluteOrUndefined(process.env.APPDATA, path) ?? path.join(home, "AppData", "Roaming");
    // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
    return absoluteOrUndefined(process.env.XDG_CONFIG_HOME, path) ?? path.join(home, ".config");
  };
  switch (client) {
    case "claude-desktop":
      return path.join(appData(), "Claude", "claude_desktop_config.json");
    case "claude-code":
      return path.join(home, ".claude.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "vscode":
      return path.join(appData(), "Code", "User", "mcp.json");
    default:
      throw new TypeError(`unknown MCP client ${JSON.stringify(client)}; expected one of ${SUPPORTED_CLIENTS.join(", ")}`);
  }
}

function absoluteOrUndefined(value: string | undefined, path: PlatformPath): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

/**
 * TODO: probe clientConfigPath() for every supported client and return the ones whose
 * config file exists and parses.
 */
export async function detectClients(): Promise<ClientConfig[]> {
  throw new Error("not implemented");
}

/** Command a wrapped entry runs. `latch init` relies on `latch` being on the client's PATH. */
export const PROXY_COMMAND = "latch";

/**
 * Rewrite one server entry so the client launches `latch proxy` instead of the real server:
 * command "latch", args ["proxy", "--server", serverId, "--", original.command, ...original.args].
 * env and unknown keys are kept, in their original order. Pure.
 *
 * Idempotent: an entry that already runs `latch proxy` is returned unchanged (the same object),
 * so re-running `latch init` never nests proxies.
 *
 * @throws TypeError when serverId is empty or starts with "-" (the proxy's option parser would
 * misread it), or the entry has no command to wrap.
 */
export function wrapWithProxy(serverId: string, original: ClientServerEntry): ClientServerEntry {
  if (isProxyInvocation(original)) return original;
  if (serverId === "" || serverId.startsWith("-")) {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: the id must be non-empty and not start with "-"`);
  }
  if (typeof original.command !== "string" || original.command === "") {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: it has no command`);
  }
  return withCommand(original, PROXY_COMMAND, ["proxy", "--server", serverId, "--", original.command, ...(original.args ?? [])]);
}

/**
 * Inverse of wrapWithProxy, used by uninstall paths: the real command and its arguments come
 * back from after the "--", with env and unknown keys kept. An entry that is not a well-formed
 * wrapped entry is returned unchanged (the same object). Pure.
 *
 * An empty argument list is restored as no `args` key, so `{ command, args: [] }` comes back as
 * `{ command }`; clients treat the two the same.
 */
export function unwrapProxy(entry: ClientServerEntry): ClientServerEntry {
  if (!isProxyInvocation(entry)) return entry;
  const args = entry.args!;
  const separator = args.indexOf("--");
  if (separator === -1 || separator + 1 >= args.length) return entry;
  return withCommand(entry, args[separator + 1]!, args.slice(separator + 2));
}

/** True for `latch proxy ...`, however the latch executable is spelled (path, .cmd, .exe). */
function isProxyInvocation(entry: ClientServerEntry): boolean {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args) || entry.args[0] !== "proxy") return false;
  const executable = entry.command.split(/[\\/]/).pop()!.toLowerCase();
  return executable === PROXY_COMMAND || executable === `${PROXY_COMMAND}.cmd` || executable === `${PROXY_COMMAND}.exe`;
}

/**
 * Copy of `entry` with a new command and args, every key in its original position. `args` is
 * appended when the entry had none, and dropped when empty. Object.fromEntries keeps a parsed
 * "__proto__" key as plain data instead of setting the prototype.
 */
function withCommand(entry: ClientServerEntry, command: string, args: string[]): ClientServerEntry {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === "command") entries.push([key, command]);
    else if (key === "args") {
      if (args.length > 0) entries.push([key, args]);
    } else entries.push([key, value]);
  }
  if (!Object.hasOwn(entry, "args") && args.length > 0) entries.push(["args", args]);
  return Object.fromEntries(entries) as ClientServerEntry;
}

/**
 * TODO: write config.raw back to config.path with config.servers merged in, after writing
 * a timestamped .bak copy of the original file. Resolves once the file is flushed.
 */
export async function writeClientConfig(config: ClientConfig): Promise<void> {
  throw new Error("not implemented");
}
