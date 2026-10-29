import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { replaceFile } from "../store/replace.js";
import { parseJsonc, setJsonc } from "./jsonc.js";
import { appDataDir, platformPath } from "./paths.js";

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
  /** The full parsed file. Written out only when the file has disappeared by the time it is rewritten. */
  raw: Record<string, unknown>;
}

/** A client config that exists but cannot be used, and why. It is left untouched. */
export interface ConfigProblem {
  client: ClientId;
  path: string;
  message: string;
}

/** What detectClients found: the usable configs, and the ones it had to leave alone. */
export interface Detection {
  configs: ClientConfig[];
  problems: ConfigProblem[];
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
  const path = platformPath(platform);
  const home = homedir();
  const appData = (): string => appDataDir(platform);
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

/** Top-level key holding the server map: VS Code's mcp.json uses "servers", the others "mcpServers". */
export function serversKey(client: ClientId): "servers" | "mcpServers" {
  return client === "vscode" ? "servers" : "mcpServers";
}

/**
 * Probe clientConfigPath() for every supported client and return, in SUPPORTED_CLIENTS order,
 * the ones whose config file exists and is one JSON object (JSONC: comments and trailing commas
 * allowed). A missing file means the client is not set up and is not reported. A file that
 * exists but cannot be read, does not parse, is not an object or keeps its servers in something
 * other than an object is reported in `problems` and left out: init must never rewrite a file it
 * could not fully read.
 *
 * `servers` holds only the stdio entries latch can wrap: a non-empty string `command`, `type`
 * absent or "stdio", `args` absent or all strings, `env` absent or an object. HTTP/SSE servers
 * and malformed entries stay in the file untouched. Only user-level servers are read; Claude
 * Code's per-project servers in ~/.claude.json are not.
 */
export async function detectClients(): Promise<Detection> {
  const results = await Promise.all(SUPPORTED_CLIENTS.map((client) => readClientConfig(client, clientConfigPath(client))));
  const detection: Detection = { configs: [], problems: [] };
  for (const result of results) {
    if (result === undefined) continue;
    if ("message" in result) detection.problems.push(result);
    else detection.configs.push(result);
  }
  return detection;
}

async function readClientConfig(client: ClientId, path: string): Promise<ClientConfig | ConfigProblem | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    return { client, path, message: `cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { client, path, message: `is not valid JSON: ${parsed.error}` };
  if (!isPlainObject(parsed.value)) return { client, path, message: "is not a JSON object" };
  const map = parsed.value[serversKey(client)];
  if (map !== undefined && !isPlainObject(map)) return { client, path, message: `keeps "${serversKey(client)}" as something other than an object` };
  return { client, path, servers: stdioServers(map), raw: parsed.value };
}

function stdioServers(value: unknown): Record<string, ClientServerEntry> {
  if (!isPlainObject(value)) return {};
  // fromEntries: a server named "__proto__" stays a plain key.
  return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, ClientServerEntry] => isStdioEntry(pair[1])));
}

function isStdioEntry(value: unknown): value is ClientServerEntry {
  if (!isPlainObject(value)) return false;
  const { command, type, args, env } = value;
  return (
    typeof command === "string" &&
    command !== "" &&
    (type === undefined || type === "stdio") &&
    (args === undefined || (Array.isArray(args) && args.every((arg) => typeof arg === "string"))) &&
    (env === undefined || isPlainObject(env))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Command a wrapped entry runs when it relies on `latch` being on the client's PATH. */
export const PROXY_COMMAND = "latch";

/** How a wrapped entry starts latch: the executable, then the arguments before "proxy". */
export interface ProxyLaunch {
  command: string;
  args: string[];
}

/** `latch` looked up on the client's PATH. */
export const PATH_LAUNCH: ProxyLaunch = { command: PROXY_COMMAND, args: [] };

/**
 * This install, by absolute path: the running node and this checkout's cli.js. Clients start
 * servers without the user's shell setup (a shell function or alias named `latch` is invisible
 * to them), so `latch init` and `latch add` write this launch.
 */
export const INSTALL_LAUNCH: ProxyLaunch = { command: process.execPath, args: [fileURLToPath(new URL("../cli.js", import.meta.url))] };

/**
 * Rewrite one server entry so the client launches `latch proxy` instead of the real server:
 * command `launch.command`, args [...launch.args, "proxy", "--server", serverId, "--",
 * original.command, ...original.args]. env and unknown keys are kept, in their original order. Pure.
 *
 * Idempotent: an entry that already runs `latch proxy` is returned unchanged (the same object),
 * so re-running `latch init` never nests proxies.
 *
 * @throws TypeError when serverId is empty or starts with "-" (the proxy's option parser would
 * misread it), or the entry has no command to wrap.
 */
export function wrapWithProxy(serverId: string, original: ClientServerEntry, launch: ProxyLaunch = PATH_LAUNCH): ClientServerEntry {
  if (isProxyInvocation(original)) return original;
  if (serverId === "" || serverId.startsWith("-")) {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: the id must be non-empty and not start with "-"`);
  }
  if (typeof original.command !== "string" || original.command === "") {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: it has no command`);
  }
  return withCommand(original, launch.command, [...launch.args, "proxy", "--server", serverId, "--", original.command, ...(original.args ?? [])]);
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

/**
 * True for `latch proxy ...`, however the latch executable is spelled (path, .cmd, .exe), and for
 * INSTALL_LAUNCH's form, `<node> <path>/cli.js proxy --server ...`.
 */
function isProxyInvocation(entry: ClientServerEntry): boolean {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const [first, second, third] = entry.args;
  if (typeof first === "string" && baseName(first) === "cli.js" && second === "proxy" && third === "--server") return true;
  if (first !== "proxy") return false;
  const executable = baseName(entry.command);
  return executable === PROXY_COMMAND || executable === `${PROXY_COMMAND}.cmd` || executable === `${PROXY_COMMAND}.exe`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!.toLowerCase();
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
 * Write `config.servers` into the client's config file, after a timestamped `.bak` copy of the
 * file as it was. Resolves once the new file is flushed to disk.
 *
 * - Only the entries of `config.servers` that differ are edited, in place (setJsonc). Every
 *   other byte of the file stays as it is: other servers (HTTP servers, servers the user did not
 *   pick), unrelated keys, comments, trailing commas, indentation, line endings and the final
 *   newline (or its absence). The diff shows only the changed entries.
 * - The edit starts from the file as it is now, not from `config.raw`: clients rewrite their
 *   config while they run (Claude Code updates ~/.claude.json constantly), and `latch init` may
 *   sit on a prompt between detecting and writing. `config.raw` is used only if the file is gone.
 * - Nothing is written, and no backup made, when every entry already holds the given value,
 *   so re-running init is a no-op.
 * - The backup and the new file get the original file's permission bits (a new file gets 0600):
 *   configs often hold API tokens in `env`.
 * - A symlinked config (dotfile managers) stays a symlink; its target is rewritten.
 * - The new content goes to a temp file that is fsynced and renamed over the target, so the
 *   client never reads half a config.
 *
 * @throws Error naming the file when it exists but is no longer a JSON object, or its server
 * map is no longer an object; it is left as is.
 */
export async function writeClientConfig(config: ClientConfig): Promise<void> {
  const target = await resolveSymlinks(config.path);
  const current = await readIfExists(target);
  const before = current?.text ?? `${JSON.stringify(config.raw, null, 2)}\n`;
  const parsed = parseJsonc(before);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    throw new Error(`${config.path} is no longer a JSON object; not rewriting it`);
  }
  const key = serversKey(config.client);
  const map = parsed.value[key];
  if (map !== undefined && !isPlainObject(map)) {
    throw new Error(`${config.path} no longer keeps "${key}" as an object; not rewriting it`);
  }

  let text = before;
  for (const [serverId, entry] of Object.entries(config.servers)) {
    // Compare values, not text: a hand-formatted entry is not reformatted when nothing changed.
    if (map !== undefined && Object.hasOwn(map, serverId) && isDeepStrictEqual(map[serverId], entry)) continue;
    text = setJsonc(text, [key, serverId], entry);
  }
  if (current !== undefined && text === current.text) return;

  const mode = current === undefined ? 0o600 : current.mode;
  if (current !== undefined) await writeBackup(config.path, current.text, mode);
  await mkdir(dirname(target), { recursive: true });
  await writeFileAtomic(target, text, mode);
}

async function resolveSymlinks(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return path;
    throw error;
  }
}

async function readIfExists(path: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mode: info.mode & 0o777 };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** `<path>.<UTC timestamp>.bak`, never overwriting an earlier backup. */
async function writeBackup(path: string, text: string, mode: number): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; ; attempt++) {
    const backup = `${path}.${stamp}${attempt === 0 ? "" : `-${attempt}`}.bak`;
    try {
      await writeFile(backup, text, { encoding: "utf8", flag: "wx", mode });
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST") || attempt >= 99) throw error;
    }
  }
}

/** Temp file, fsync, rename: the target holds either the old or the new content, never a mix. */
async function writeFileAtomic(path: string, text: string, mode: number): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
