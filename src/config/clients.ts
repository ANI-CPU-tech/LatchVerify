import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { replaceFile } from "../store/replace.js";
import { SUPPORTED_CLIENTS, type ClientId } from "./client-ids.js";
import { parseJsonc, setJsonc } from "./jsonc.js";
import { appDataDir, platformPath } from "./paths.js";

export { SUPPORTED_CLIENTS, type ClientId };

/** One server entry as clients store it on disk. */
export interface ClientServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [extra: string]: unknown;
}

/** A file a client keeps MCP servers in, and the keys from its root to the server map. */
export interface ClientLocation {
  path: string;
  serversPath: string[];
}

/** A client config located on this machine. */
export interface ClientConfig extends ClientLocation {
  client: ClientId;
  /** Which part of the file, for people, when it is not the whole client: "project /home/me/app". */
  scope?: string;
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
 * The files where `client` keeps its user-level MCP servers on `platform`, most important first,
 * as absolute paths. Each was checked against the client's own documentation or source on
 * 2026-10-29; the source is noted next to it.
 *
 * | Client          | File (Windows / Linux)                                             | Server map      |
 * |-----------------|--------------------------------------------------------------------|-----------------|
 * | claude-desktop  | <app data>/Claude/claude_desktop_config.json                       | mcpServers      |
 * | claude-code     | ~/.claude.json                                                     | mcpServers      |
 * | cursor          | ~/.cursor/mcp.json                                                 | mcpServers      |
 * | vscode          | <app data>/Code/User/mcp.json                                      | servers         |
 * | vscode-insiders | <app data>/Code - Insiders/User/mcp.json                           | servers         |
 * | vscodium        | <app data>/VSCodium/User/mcp.json                                  | servers         |
 * | cline           | <app data>/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json | mcpServers |
 * | cline-cli       | ~/.cline/data/settings/cline_mcp_settings.json                     | mcpServers      |
 * | gemini-cli      | ~/.gemini/settings.json                                            | mcpServers      |
 * | zed             | %APPDATA%/Zed/settings.json, <config>/zed/settings.json            | context_servers |
 * | lm-studio       | ~/.lmstudio/mcp.json                                               | mcpServers      |
 * | amazon-q        | ~/.aws/amazonq/mcp.json, then ~/.aws/amazonq/default.json          | mcpServers      |
 *
 * <app data> is %APPDATA% on Windows (falling back to ~/AppData/Roaming), $XDG_CONFIG_HOME or
 * ~/.config on Linux, and ~/Library/Application Support on macOS (appDataDir). ~ is
 * os.homedir(), so HOME (USERPROFILE on Windows) redirects every path. Environment overrides a
 * client offers for its own config (CLINE_DIR, CLINE_MCP_SETTINGS_PATH, ...) are not followed.
 *
 * Left out after checking, 2026-10-29: Roo Code (its extension was shut down on 2026-05-15) and
 * Windsurf, now Devin Desktop (its own docs give two different MCP config paths).
 */
export function clientLocations(client: ClientId, platform: NodeJS.Platform = process.platform): ClientLocation[] {
  const path = platformPath(platform);
  const home = homedir();
  const appData = (): string => appDataDir(platform);
  const at = (file: string, ...serversPath: string[]): ClientLocation[] => [{ path: file, serversPath }];
  switch (client) {
    // https://modelcontextprotocol.io/docs/develop/connect-local-servers
    case "claude-desktop":
      return at(path.join(appData(), "Claude", "claude_desktop_config.json"), "mcpServers");
    // https://code.claude.com/docs/en/mcp (user scope: top level of ~/.claude.json)
    case "claude-code":
      return at(path.join(home, ".claude.json"), "mcpServers");
    // https://cursor.com/docs/context/mcp
    case "cursor":
      return at(path.join(home, ".cursor", "mcp.json"), "mcpServers");
    // https://code.visualstudio.com/docs/agents/reference/mcp-configuration (user profile mcp.json);
    // the profile folder is <app data>/<product nameShort>/User (vscode src/vs/platform/environment/node/userDataPath.ts)
    case "vscode":
      return at(path.join(appData(), "Code", "User", "mcp.json"), "servers");
    // As vscode, with the Insiders product name "Code - Insiders".
    case "vscode-insiders":
      return at(path.join(appData(), "Code - Insiders", "User", "mcp.json"), "servers");
    // As vscode, with VSCodium's product name (vscodium prepare_vscode.sh sets nameShort "VSCodium").
    case "vscodium":
      return at(path.join(appData(), "VSCodium", "User", "mcp.json"), "servers");
    // The VS Code extension keeps it in its global storage, settings/ (cline apps/vscode/src/core/storage/disk.ts);
    // https://docs.cline.bot/mcp/configuring-mcp-servers
    case "cline":
      return at(path.join(appData(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), "mcpServers");
    // https://docs.cline.bot/mcp/configuring-mcp-servers (CLI)
    case "cline-cli":
      return at(path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json"), "mcpServers");
    // https://geminicli.com/docs/tools/mcp-server/
    case "gemini-cli":
      return at(path.join(home, ".gemini", "settings.json"), "mcpServers");
    // https://zed.dev/docs/ai/mcp (context_servers); https://zed.dev/docs/configuring-zed (file location)
    case "zed":
      if (platform === "win32") return at(path.join(appData(), "Zed", "settings.json"), "context_servers");
      return at(path.join(platform === "darwin" ? path.join(home, ".config") : appData(), "zed", "settings.json"), "context_servers");
    // https://lmstudio.ai/blog/mcp
    case "lm-studio":
      return at(path.join(home, ".lmstudio", "mcp.json"), "mcpServers");
    // https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html: the IDE GUI writes default.json; the
    // legacy mcp.json is still read by default (useLegacyMcpJson) and is what `latch add` writes, its format being plain.
    case "amazon-q":
      return [
        { path: path.join(home, ".aws", "amazonq", "mcp.json"), serversPath: ["mcpServers"] },
        { path: path.join(home, ".aws", "amazonq", "default.json"), serversPath: ["mcpServers"] },
      ];
    default:
      throw new TypeError(`unknown MCP client ${JSON.stringify(client)}; expected one of ${SUPPORTED_CLIENTS.join(", ")}`);
  }
}

/** The main config file of `client` on `platform`: the one `latch add` writes and messages name. */
export function clientConfigPath(client: ClientId, platform: NodeJS.Platform = process.platform): string {
  return clientLocations(client, platform)[0]!.path;
}

/** The value at `keys` inside `root`, or undefined when a key on the way is missing or not an object's. */
export function valueAt(root: unknown, keys: readonly string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!isPlainObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Probe clientLocations() for every supported client and return, in SUPPORTED_CLIENTS order,
 * the ones whose config file exists and is one JSON object (JSONC: comments and trailing commas
 * allowed). A missing file means the client is not set up and is not reported. A file that
 * exists but cannot be read, does not parse, is not an object or keeps its servers in something
 * other than an object is reported in `problems` and left out: init must never rewrite a file it
 * could not fully read.
 *
 * `servers` holds only the stdio entries latch can wrap: a non-empty string `command`, `type`
 * absent or "stdio", `args` absent or all strings, `env` absent or an object. HTTP/SSE servers
 * and malformed entries stay in the file untouched.
 *
 * Claude Code also keeps servers per project in ~/.claude.json, under
 * projects["<project path>"].mcpServers (its "local" scope). Each project with servers there is
 * one more config, with that serversPath and a `scope` naming the project. Project-scoped
 * .mcp.json files are not read: they are shared through version control, and a wrapped entry
 * holds this machine's paths.
 */
export async function detectClients(): Promise<Detection> {
  const results = await Promise.all(
    SUPPORTED_CLIENTS.flatMap((client) => clientLocations(client).map((location) => readClientConfig(client, location))),
  );
  const detection: Detection = { configs: [], problems: [] };
  for (const result of results.flat()) {
    if ("message" in result) detection.problems.push(result);
    else detection.configs.push(result);
  }
  return detection;
}

/** Claude Code's per-project configs in the ~/.claude.json `user` config, in file order. */
function claudeCodeProjects(user: ClientConfig): Array<ClientConfig | ConfigProblem> {
  const projects = user.raw.projects;
  if (!isPlainObject(projects)) return [];
  return Object.entries(projects).flatMap(([project, settings]): Array<ClientConfig | ConfigProblem> => {
    const map = isPlainObject(settings) ? settings.mcpServers : undefined;
    if (map === undefined) return [];
    const serversPath = ["projects", project, "mcpServers"];
    if (!isPlainObject(map)) return [{ client: user.client, path: user.path, message: `keeps "${serversPath.join(".")}" as something other than an object` }];
    if (Object.keys(map).length === 0) return [];
    return [{ ...user, serversPath, scope: `project ${project}`, servers: stdioServers(map) }];
  });
}

/** The config at `location` (and, for Claude Code, its projects'), problems, or nothing when the file is missing. */
async function readClientConfig(client: ClientId, { path, serversPath }: ClientLocation): Promise<Array<ClientConfig | ConfigProblem>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    return [{ client, path, message: `cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` }];
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok) return [{ client, path, message: `is not valid JSON: ${parsed.error}` }];
  if (!isPlainObject(parsed.value)) return [{ client, path, message: "is not a JSON object" }];
  const map = valueAt(parsed.value, serversPath);
  if (map !== undefined && !isPlainObject(map)) return [{ client, path, message: `keeps "${serversPath.join(".")}" as something other than an object` }];
  const config: ClientConfig = { client, path, serversPath, servers: stdioServers(map), raw: parsed.value };
  return client === "claude-code" ? [config, ...claudeCodeProjects(config)] : [config];
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
 * Node options for every proxy a client starts through INSTALL_LAUNCH. A client keeps one proxy
 * per server alive, and a 1 MiB young generation instead of V8's 16 MiB default keeps about
 * 6 MiB less resident in each (measured on Node 22). Proxy traffic is small and short-lived, so
 * the extra scavenges cost nothing noticeable. The old generation is left unbounded: one message
 * can legitimately be tens of MiB.
 */
export const PROXY_NODE_FLAGS: readonly string[] = ["--max-semi-space-size=1"];

/**
 * This install, by absolute path: the running node and this checkout's cli.js. Clients start
 * servers without the user's shell setup (a shell function or alias named `latch` is invisible
 * to them), so `latch init` and `latch add` write this launch.
 */
export const INSTALL_LAUNCH: ProxyLaunch = { command: process.execPath, args: [...PROXY_NODE_FLAGS, fileURLToPath(new URL("../cli.js", import.meta.url))] };

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
 * How a wrapped entry starts latch: its command and the arguments before "proxy". Undefined for
 * an entry that does not run `latch proxy`.
 */
export function proxyLaunchOf(entry: ClientServerEntry): ProxyLaunch | undefined {
  if (!isProxyInvocation(entry)) return undefined;
  const args = entry.args!;
  return { command: entry.command, args: args.slice(0, args.indexOf("proxy")) };
}

/**
 * Whether a wrapped entry's `own` launch should give way to `launch`, this install's: when it is
 * this install already (only the node flags differ, as in entries written before
 * PROXY_NODE_FLAGS), or when its node or cli.js no longer exists (a moved or removed install,
 * whose servers would not start at all). Any other launch, such as an entry wrapped by hand or by
 * another working install, is the user's and is kept.
 */
export function replacesLaunch(own: ProxyLaunch, launch: ProxyLaunch, exists: (path: string) => boolean = existsSync): boolean {
  const script = (candidate: ProxyLaunch) => candidate.args.find((arg) => !arg.startsWith("-"));
  if (own.command === launch.command && script(own) === script(launch)) return !isDeepStrictEqual(own, launch);
  const paths = [own.command, ...(script(own) === undefined ? [] : [script(own)!])].filter((path) => isAbsolute(path));
  return paths.some((path) => !exists(path));
}

/**
 * True for `latch proxy ...`, however the latch executable is spelled (path, .cmd, .exe), and for
 * INSTALL_LAUNCH's form, `<node> [node flags] <path>/cli.js proxy --server ...`, with or without
 * the flags (entries written before PROXY_NODE_FLAGS existed have none).
 */
function isProxyInvocation(entry: ClientServerEntry): boolean {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const [first] = entry.args;
  const script = entry.args.findIndex((arg) => typeof arg !== "string" || !arg.startsWith("-"));
  const [cli, second, third] = script === -1 ? [] : entry.args.slice(script);
  if (typeof cli === "string" && baseName(cli) === "cli.js" && second === "proxy" && third === "--server") return true;
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
 * file as it was (the MAX_BACKUPS newest are kept). Resolves once the new file is flushed to disk.
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
  const map = valueAt(parsed.value, config.serversPath);
  if (map !== undefined && !isPlainObject(map)) {
    throw new Error(`${config.path} no longer keeps "${config.serversPath.join(".")}" as an object; not rewriting it`);
  }

  let text = before;
  for (const [serverId, entry] of Object.entries(config.servers)) {
    // Compare values, not text: a hand-formatted entry is not reformatted when nothing changed.
    if (map !== undefined && Object.hasOwn(map, serverId) && isDeepStrictEqual(map[serverId], entry)) continue;
    text = setJsonc(text, [...config.serversPath, serverId], entry);
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

/** Backups kept per config file; older ones are deleted after each new one. */
export const MAX_BACKUPS = 5;

/**
 * `<path>.<UTC timestamp>.bak`, never overwriting an earlier backup. Then only the MAX_BACKUPS
 * newest backups of `path` are kept: the background sync rewrites configs often, and an
 * unbounded pile of copies (which may hold tokens) helps nobody.
 */
async function writeBackup(path: string, text: string, mode: number): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; ; attempt++) {
    const backup = `${path}.${stamp}${attempt === 0 ? "" : `-${attempt}`}.bak`;
    try {
      await writeFile(backup, text, { encoding: "utf8", flag: "wx", mode });
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST") || attempt >= 99) throw error;
    }
  }
  await pruneBackups(path);
}

/** Deletes all but the MAX_BACKUPS newest of `path`'s backups. Never fails the write that made one. */
async function pruneBackups(path: string): Promise<void> {
  const name = basename(path);
  const pattern = /^\.(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d+))?\.bak$/;
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return;
  }
  const backups = names.flatMap((file) => {
    const match = file.startsWith(name) ? pattern.exec(file.slice(name.length)) : null;
    return match ? [{ file, stamp: match[1]!, attempt: Number(match[2] ?? 0) }] : [];
  });
  // Newest first: by timestamp, then by the -N suffix taken within one millisecond.
  backups.sort((a, b) => (a.stamp === b.stamp ? b.attempt - a.attempt : a.stamp < b.stamp ? 1 : -1));
  await Promise.all(backups.slice(MAX_BACKUPS).map(({ file }) => rm(join(dirname(path), file), { force: true }).catch(() => undefined)));
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
