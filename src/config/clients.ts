import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
  /**
   * The names of the entry's env variables, never their values: those are the server's API keys,
   * dropped as soon as the file is parsed (stdioServers), so no key enters LatchVerify's data.
   */
  envNames?: string[];
}

/** Anything started by a command and arguments: a detected entry, a new one, or an entry as it is on disk. */
export interface Launchable {
  command: string;
  args?: string[];
}

/**
 * A server entry `latch add` creates. The one place LatchVerify writes env values: the ones the
 * user passed to it with --env. An entry that already exists never has its env written.
 */
export interface NewServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
  /** The stdio entries latch can wrap: launch and env variable names, no env values. Args may still hold a key: never print or store them. */
  servers: Record<string, ClientServerEntry>;
  /** Every server id in the map, stdio or not, so a new name never replaces an HTTP server. */
  serverIds: string[];
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

/** Claude Code's per-project configs in ~/.claude.json (`root`, the parsed file; `user`, its user-scope config), in file order. */
function claudeCodeProjects(user: ClientConfig, root: Record<string, unknown>): Array<ClientConfig | ConfigProblem> {
  const projects = root.projects;
  if (!isPlainObject(projects)) return [];
  return Object.entries(projects).flatMap(([project, settings]): Array<ClientConfig | ConfigProblem> => {
    const map = isPlainObject(settings) ? settings.mcpServers : undefined;
    if (map === undefined) return [];
    const serversPath = ["projects", project, "mcpServers"];
    if (!isPlainObject(map)) return [{ client: user.client, path: user.path, message: `keeps "${serversPath.join(".")}" as something other than an object` }];
    if (Object.keys(map).length === 0) return [];
    return [{ ...user, serversPath, scope: `project ${project}`, servers: stdioServers(map), serverIds: Object.keys(map) }];
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
  const config: ClientConfig = { client, path, serversPath, servers: stdioServers(map), serverIds: isPlainObject(map) ? Object.keys(map) : [] };
  return client === "claude-code" ? [config, ...claudeCodeProjects(config, parsed.value)] : [config];
}

/** How earlier versions named the copy they kept of a config before rewriting it: <config>.<UTC stamp>[-N].bak. */
const OLD_BACKUP = /^\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(?:-\d+)?\.bak$/;

/**
 * The backup copies earlier LatchVerify versions left beside client configs. Each is a whole copy
 * of a config, keys included, so the user is told to delete them; LatchVerify never reads or
 * deletes them itself. Found by file name only, sorted.
 */
export async function findOldBackups(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const found = new Set<string>();
  for (const client of SUPPORTED_CLIENTS) {
    for (const { path } of clientLocations(client, platform)) {
      const name = basename(path);
      const names = await readdir(dirname(path)).catch((): string[] => []);
      for (const file of names) if (file.startsWith(name) && OLD_BACKUP.test(file.slice(name.length))) found.add(join(dirname(path), file));
    }
  }
  return [...found].sort();
}

/** Keys under which MCP configs keep their server maps, across clients and project files. */
const SERVER_MAP_KEYS = ["mcpServers", "servers", "context_servers"] as const;

/**
 * The stdio servers of any MCP config file (a project's .mcp.json, a client's config), by id, as
 * detection reduces them: launch and env variable names, no env values. Wrapped entries are given
 * back unwrapped, with their real launch. For `latch verify`, which needs launch lines that
 * latch.lock does not keep.
 *
 * @throws Error naming the file when it cannot be read or is not a JSON object.
 */
export async function readServersFile(path: string): Promise<Record<string, ClientServerEntry>> {
  const parsed = parseJsonc(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`${path} is not valid JSON: ${parsed.error}`);
  if (!isPlainObject(parsed.value)) throw new Error(`${path} is not a JSON object`);
  const servers: Record<string, ClientServerEntry> = {};
  for (const key of SERVER_MAP_KEYS) {
    for (const [id, entry] of Object.entries(stdioServers(parsed.value[key]))) {
      if (!Object.hasOwn(servers, id)) Object.defineProperty(servers, id, { value: unwrapProxy(entry), enumerable: true, writable: true, configurable: true });
    }
  }
  return servers;
}

/**
 * The stdio entries of a server map, each reduced to its command, args and env variable names.
 * Env values and every other key are left behind here, right after parsing.
 */
function stdioServers(value: unknown): Record<string, ClientServerEntry> {
  if (!isPlainObject(value)) return {};
  // fromEntries: a server named "__proto__" stays a plain key.
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]): Array<[string, ClientServerEntry]> => {
      if (!isStdioEntry(raw)) return [];
      const entry: ClientServerEntry = { command: raw.command as string };
      if (raw.args !== undefined) entry.args = [...(raw.args as string[])];
      if (raw.env !== undefined) entry.envNames = Object.keys(raw.env as object);
      return [[id, entry]];
    }),
  );
}

function isStdioEntry(value: unknown): value is Record<string, unknown> {
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

/** Where a wrapped entry's proxy finds latch.lock and its state directory, given as latch options. */
export interface ProxyPaths {
  lockfilePath: string;
  stateDir: string;
}

/** latch's global options a wrapped entry may carry between the launch and "proxy", each with a value. */
const PATH_OPTIONS: ReadonlySet<string> = new Set(["--lockfile", "--state-dir"]);

/**
 * Rewrite one server entry so the client launches `latch proxy` instead of the real server:
 * command `launch.command`, args [...launch.args, "--lockfile", <path>, "--state-dir", <dir>,
 * "proxy", "--server", serverId, "--", original.command, ...original.args], the two options only
 * with `paths`. Only `command` and `args` change: env (which holds the server's API keys) and
 * unknown keys are kept as they are, in their original order. The paths travel as options, not as
 * env, for that reason. Pure.
 *
 * Idempotent: an entry that already runs `latch proxy` is returned unchanged (the same object),
 * so re-running `latch init` never nests proxies.
 *
 * @throws TypeError when serverId is empty or starts with "-" (the proxy's option parser would
 * misread it), or the entry has no command to wrap.
 */
export function wrapWithProxy<T extends Launchable>(serverId: string, original: T, launch: ProxyLaunch = PATH_LAUNCH, paths?: ProxyPaths): T {
  if (isProxyInvocation(original)) return original;
  if (serverId === "" || serverId.startsWith("-")) {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: the id must be non-empty and not start with "-"`);
  }
  if (typeof original.command !== "string" || original.command === "") {
    throw new TypeError(`cannot wrap server ${JSON.stringify(serverId)}: it has no command`);
  }
  const options = paths === undefined ? [] : ["--lockfile", paths.lockfilePath, "--state-dir", paths.stateDir];
  return withCommand(original, launch.command, [...launch.args, ...options, "proxy", "--server", serverId, "--", original.command, ...(original.args ?? [])]);
}

/**
 * Inverse of wrapWithProxy, used by uninstall paths: the real command and its arguments come
 * back from after the "--", with env and unknown keys kept. An entry that is not a well-formed
 * wrapped entry is returned unchanged (the same object). Pure.
 *
 * An empty argument list is restored as no `args` key, so `{ command, args: [] }` comes back as
 * `{ command }`; clients treat the two the same.
 */
export function unwrapProxy<T extends Launchable>(entry: T): T {
  if (!isProxyInvocation(entry)) return entry;
  const args = entry.args!;
  const separator = args.indexOf("--");
  if (separator === -1 || separator + 1 >= args.length) return entry;
  return withCommand(entry, args[separator + 1]!, args.slice(separator + 2));
}

/**
 * How a wrapped entry starts latch: its command and the arguments before latch's own options and
 * "proxy" (node flags and cli.js, or nothing for `latch` itself). Undefined for an entry that does
 * not run `latch proxy`.
 */
export function proxyLaunchOf(entry: Launchable): ProxyLaunch | undefined {
  const at = latchArgsStart(entry);
  return at === undefined ? undefined : { command: entry.command, args: entry.args!.slice(0, at) };
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
function isProxyInvocation(entry: Launchable): boolean {
  return latchArgsStart(entry) !== undefined;
}

/**
 * For an entry that runs `latch proxy`, the index in its args where latch's own arguments start
 * (any --lockfile/--state-dir options, then "proxy --server"): 0 for `latch ...`, just after
 * cli.js for `<node> [node flags] <path>/cli.js ...`. Undefined for any other entry.
 */
function latchArgsStart(entry: Launchable): number | undefined {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return undefined;
  const args = entry.args;
  const proxyAt = (start: number): boolean => {
    let at = start;
    while (typeof args[at] === "string" && PATH_OPTIONS.has(args[at] as string)) at += 2;
    return args[at] === "proxy" && args[at + 1] === "--server";
  };
  const script = args.findIndex((arg) => typeof arg !== "string" || !arg.startsWith("-"));
  const cli = script === -1 ? undefined : args[script];
  if (typeof cli === "string" && baseName(cli) === "cli.js" && proxyAt(script + 1)) return script + 1;
  const executable = baseName(entry.command);
  const isLatch = executable === PROXY_COMMAND || executable === `${PROXY_COMMAND}.cmd` || executable === `${PROXY_COMMAND}.exe`;
  return isLatch && proxyAt(0) ? 0 : undefined;
}

/** Variables older versions of latch init put in a wrapped entry's env; relinking and unlinking remove exactly these. */
export const LATCH_ENTRY_ENV = ["LATCH_LOCKFILE_PATH", "LATCH_STATE_DIR"] as const;

const isLatchEnv = (name: string) => (LATCH_ENTRY_ENV as readonly string[]).includes(name);

/**
 * `entry` without the names of LATCH_ENTRY_ENV: what it is once writeClientConfig has deleted
 * those variables. Other names are kept; an empty list is dropped.
 */
export function withoutLatchEnv(entry: ClientServerEntry): ClientServerEntry {
  if (entry.envNames === undefined || !entry.envNames.some(isLatchEnv)) return entry;
  const envNames = entry.envNames.filter((name) => !isLatchEnv(name));
  const { envNames: _dropped, ...rest } = entry;
  return envNames.length > 0 ? { ...rest, envNames } : rest;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!.toLowerCase();
}

/**
 * Copy of `entry` with a new command and args, every key in its original position. `args` is
 * appended when the entry had none, and dropped when empty. Object.fromEntries keeps a parsed
 * "__proto__" key as plain data instead of setting the prototype.
 */
function withCommand<T extends Launchable>(entry: T, command: string, args: string[]): T {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === "command") entries.push([key, command]);
    else if (key === "args") {
      if (args.length > 0) entries.push([key, args]);
    } else entries.push([key, value]);
  }
  if (!Object.hasOwn(entry, "args") && args.length > 0) entries.push(["args", args]);
  return Object.fromEntries(entries) as unknown as T;
}

/**
 * Write `config.servers` into the client's config file. Resolves once the new file is flushed to
 * disk.
 *
 * - Of an entry that exists, only `command` and `args` are written, plus the deletion of the
 *   LATCH_* variables older versions put in its env (LATCH_ENTRY_ENV), by name. Nothing else in
 *   it is read into LatchVerify's data or written: env values (the server's API keys) and every
 *   other key stay byte for byte as they are. A whole entry is written only for a server the map
 *   does not have yet: a NewServerEntry from `latch add`, with the env the user gave it.
 * - Every other byte of the file stays as it is: other servers, unrelated keys, comments,
 *   trailing commas, indentation, line endings and the final newline (or its absence).
 * - No copy of the file is made: it holds the user's keys, and the original command of a wrapped
 *   entry stays in its own args after "--", which is all unlinking needs.
 * - The edit starts from the file as it is now: clients rewrite their config while they run
 *   (Claude Code updates ~/.claude.json constantly), and `latch init` may sit on a prompt between
 *   detecting and writing. When the file is gone, it is created with just these servers.
 * - Nothing is written when every value is already as given, so re-running init is a no-op.
 * - The new file keeps the original's permission bits (a new file gets 0600).
 * - A symlinked config (dotfile managers) stays a symlink; its target is rewritten.
 * - The new content goes to a temp file that is fsynced and renamed over the target, so the
 *   client never reads half a config.
 *
 * @throws Error naming the file when it exists but is no longer a JSON object, or its server
 * map is no longer an object; it is left as is.
 */
export async function writeClientConfig(config: {
  path: string;
  serversPath: string[];
  servers: Record<string, ClientServerEntry | NewServerEntry>;
}): Promise<void> {
  const target = await resolveSymlinks(config.path);
  const current = await readIfExists(target);
  const before = current?.text ?? "{}\n";
  // The edits are planned inside this block; the parsed file (keys included) is not kept.
  const planned: Array<[string[], unknown]> = [];
  {
    const parsed = parseJsonc(before);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      throw new Error(`${config.path} is no longer a JSON object; not rewriting it`);
    }
    const map = valueAt(parsed.value, config.serversPath);
    if (map !== undefined && !isPlainObject(map)) {
      throw new Error(`${config.path} no longer keeps "${config.serversPath.join(".")}" as an object; not rewriting it`);
    }
    for (const [serverId, entry] of Object.entries(config.servers)) {
      const path = [...config.serversPath, serverId];
      const now = map !== undefined && Object.hasOwn(map, serverId) ? map[serverId] : undefined;
      if (!isPlainObject(now)) {
        const created: Record<string, unknown> = { command: entry.command };
        if (entry.args !== undefined && entry.args.length > 0) created.args = entry.args;
        if ("env" in entry && entry.env !== undefined && Object.keys(entry.env).length > 0) created.env = entry.env;
        planned.push([path, created]);
        continue;
      }
      if (now.command !== entry.command) planned.push([[...path, "command"], entry.command]);
      const args = entry.args !== undefined && entry.args.length > 0 ? entry.args : undefined;
      const nowArgs = Array.isArray(now.args) && now.args.length > 0 ? now.args : undefined;
      if (!isDeepStrictEqual(nowArgs, args)) planned.push([[...path, "args"], args]);
      const envNames = isPlainObject(now.env) ? Object.keys(now.env) : [];
      const ours = envNames.filter(isLatchEnv);
      if (ours.length > 0 && ours.length === envNames.length) planned.push([[...path, "env"], undefined]);
      else for (const name of ours) planned.push([[...path, "env", name], undefined]);
    }
  }
  let text = before;
  for (const [path, value] of planned) text = setJsonc(text, path, value);
  if (current !== undefined && text === current.text) return;

  const mode = current === undefined ? 0o600 : current.mode;
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
