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

/**
 * Rewrite one server entry so the client launches `latch proxy` instead of the real server.
 * TODO: return a new entry with command "latch", args ["proxy", "--server", serverId, "--",
 * original.command, ...original.args], preserving env and unknown keys. Must be idempotent:
 * an entry already wrapped is returned unchanged.
 */
export function wrapWithProxy(serverId: string, original: ClientServerEntry): ClientServerEntry {
  throw new Error("not implemented");
}

/**
 * Inverse of wrapWithProxy, used by uninstall paths.
 * TODO: return the original entry if wrapped, or the input unchanged.
 */
export function unwrapProxy(entry: ClientServerEntry): ClientServerEntry {
  throw new Error("not implemented");
}

/**
 * TODO: write config.raw back to config.path with config.servers merged in, after writing
 * a timestamped .bak copy of the original file. Resolves once the file is flushed.
 */
export async function writeClientConfig(config: ClientConfig): Promise<void> {
  throw new Error("not implemented");
}
