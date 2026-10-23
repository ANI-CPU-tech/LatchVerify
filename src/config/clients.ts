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
 * Platform-specific config file location for a client.
 * TODO: map each ClientId to its macOS / Linux / Windows path (e.g. Claude Desktop's
 * claude_desktop_config.json, Cursor's ~/.cursor/mcp.json). Returns an absolute path.
 */
export function clientConfigPath(client: ClientId, platform: NodeJS.Platform = process.platform): string {
  throw new Error("not implemented");
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
