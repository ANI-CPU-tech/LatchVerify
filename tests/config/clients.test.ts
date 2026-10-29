import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../src/config/jsonc.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_LAUNCH,
  PROXY_COMMAND,
  PROXY_NODE_FLAGS,
  proxyLaunchOf,
  replacesLaunch,
  SUPPORTED_CLIENTS,
  clientConfigPath,
  clientLocations,
  detectClients,
  unwrapProxy,
  withoutLatchEnv,
  wrapWithProxy,
  writeClientConfig,
  type ClientConfig,
  type ClientId,
  type ClientServerEntry,
} from "../../src/config/clients.js";

// os.homedir() follows HOME only on POSIX hosts.
const onWindows = process.platform === "win32";

/** The key of a client's main server map ("mcpServers", "servers" or "context_servers"). */
const mapKey = (client: ClientId): string => clientLocations(client)[0]!.serversPath[0]!;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientConfigPath", () => {
  it.skipIf(onWindows)("uses the documented locations on Linux", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(Object.fromEntries(SUPPORTED_CLIENTS.map((client) => [client, clientLocations(client, "linux")]))).toEqual({
      "claude-desktop": [{ path: "/home/dev/.config/Claude/claude_desktop_config.json", serversPath: ["mcpServers"] }],
      "claude-code": [{ path: "/home/dev/.claude.json", serversPath: ["mcpServers"] }],
      cursor: [{ path: "/home/dev/.cursor/mcp.json", serversPath: ["mcpServers"] }],
      vscode: [{ path: "/home/dev/.config/Code/User/mcp.json", serversPath: ["servers"] }],
      "vscode-insiders": [{ path: "/home/dev/.config/Code - Insiders/User/mcp.json", serversPath: ["servers"] }],
      vscodium: [{ path: "/home/dev/.config/VSCodium/User/mcp.json", serversPath: ["servers"] }],
      cline: [
        { path: "/home/dev/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", serversPath: ["mcpServers"] },
      ],
      "cline-cli": [{ path: "/home/dev/.cline/data/settings/cline_mcp_settings.json", serversPath: ["mcpServers"] }],
      "gemini-cli": [{ path: "/home/dev/.gemini/settings.json", serversPath: ["mcpServers"] }],
      zed: [{ path: "/home/dev/.config/zed/settings.json", serversPath: ["context_servers"] }],
      "lm-studio": [{ path: "/home/dev/.lmstudio/mcp.json", serversPath: ["mcpServers"] }],
      "amazon-q": [
        { path: "/home/dev/.aws/amazonq/mcp.json", serversPath: ["mcpServers"] },
        { path: "/home/dev/.aws/amazonq/default.json", serversPath: ["mcpServers"] },
      ],
    });
    expect(SUPPORTED_CLIENTS.map((client) => clientConfigPath(client, "linux"))).toEqual(
      SUPPORTED_CLIENTS.map((client) => clientLocations(client, "linux")[0]!.path),
    );
  });

  it.skipIf(onWindows)("honours an absolute XDG_CONFIG_HOME on Linux and ignores a relative one", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/data/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/data/config/Claude/claude_desktop_config.json");
    expect(clientConfigPath("vscode", "linux")).toBe("/data/config/Code/User/mcp.json");
    expect(clientConfigPath("cursor", "linux")).toBe("/home/dev/.cursor/mcp.json");
    expect(clientConfigPath("zed", "linux")).toBe("/data/config/zed/settings.json");
    expect(clientConfigPath("cline", "linux")).toBe("/data/config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
    vi.stubEnv("XDG_CONFIG_HOME", "relative/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/home/dev/.config/Claude/claude_desktop_config.json");
  });

  it.skipIf(onWindows)("uses Application Support on macOS", () => {
    vi.stubEnv("HOME", "/Users/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/ignored");
    expect(clientConfigPath("claude-desktop", "darwin")).toBe("/Users/dev/Library/Application Support/Claude/claude_desktop_config.json");
    expect(clientConfigPath("vscode", "darwin")).toBe("/Users/dev/Library/Application Support/Code/User/mcp.json");
    expect(clientConfigPath("cursor", "darwin")).toBe("/Users/dev/.cursor/mcp.json");
    // Zed keeps ~/.config on macOS too.
    expect(clientConfigPath("zed", "darwin")).toBe("/Users/dev/.config/zed/settings.json");
  });

  it.skipIf(onWindows)("uses %APPDATA% and Windows separators on Windows", () => {
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming");
    expect(clientConfigPath("claude-desktop", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(clientConfigPath("vscode", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\mcp.json");
    expect(clientConfigPath("cursor", "win32").endsWith("\\.cursor\\mcp.json")).toBe(true);
    expect(clientConfigPath("claude-code", "win32").endsWith("\\.claude.json")).toBe(true);
    expect(clientConfigPath("vscode-insiders", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Code - Insiders\\User\\mcp.json");
    expect(clientConfigPath("vscodium", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\VSCodium\\User\\mcp.json");
    expect(clientConfigPath("cline", "win32")).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json",
    );
    expect(clientConfigPath("zed", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Zed\\settings.json");
    expect(clientConfigPath("lm-studio", "win32").endsWith("\\.lmstudio\\mcp.json")).toBe(true);
    expect(clientConfigPath("gemini-cli", "win32").endsWith("\\.gemini\\settings.json")).toBe(true);
    expect(clientLocations("amazon-q", "win32").map((location) => location.path.split("\\").slice(-3).join("/"))).toEqual([
      ".aws/amazonq/mcp.json",
      ".aws/amazonq/default.json",
    ]);
  });

  it.skipIf(onWindows)("falls back to AppData/Roaming under the home directory without %APPDATA%", () => {
    vi.stubEnv("APPDATA", undefined);
    expect(clientConfigPath("claude-desktop", "win32").endsWith("\\AppData\\Roaming\\Claude\\claude_desktop_config.json")).toBe(true);
  });

  it("follows the current platform and home directory by default", () => {
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(clientConfigPath("cursor")).toBe(join(homedir(), ".cursor", "mcp.json"));
    expect(clientConfigPath("claude-code")).toBe(join(homedir(), ".claude.json"));
  });

  it("rejects an unknown client at runtime", () => {
    expect(() => clientConfigPath("windsurf" as ClientId)).toThrow('unknown MCP client "windsurf"');
  });
});

describe("wrapWithProxy", () => {
  const orig: ClientServerEntry = { command: "node", args: ["w.js"], env: { A: "1" }, extra: true };

  it("launches latch proxy with the real command after --", () => {
    expect(wrapWithProxy("weather", orig)).toEqual({
      command: "latch",
      args: ["proxy", "--server", "weather", "--", "node", "w.js"],
      env: { A: "1" },
      extra: true,
    });
    expect(PROXY_COMMAND).toBe("latch");
  });

  it("matches the example in docs/ARCHITECTURE.md", () => {
    expect(wrapWithProxy("weather", { command: "node", args: ["weather.js"] })).toEqual({
      command: "latch",
      args: ["proxy", "--server", "weather", "--", "node", "weather.js"],
    });
  });

  it("keeps every other key in its original position", () => {
    const entry = { type: "stdio", command: "npx", env: { B: "2" }, args: ["-y", "pkg"], cwd: "/srv" };
    expect(Object.keys(wrapWithProxy("s", entry))).toEqual(["type", "command", "env", "args", "cwd"]);
  });

  it("adds args after the other keys when the entry had none", () => {
    expect(wrapWithProxy("s", { command: "server", env: { A: "1" } })).toEqual({
      command: "latch",
      env: { A: "1" },
      args: ["proxy", "--server", "s", "--", "server"],
    });
  });

  it("passes the real arguments through literally, including -- and options", () => {
    const entry = { command: "npx", args: ["tsx", "--", "--server", "x", ""] };
    expect(wrapWithProxy("s", entry).args).toEqual(["proxy", "--server", "s", "--", "npx", "tsx", "--", "--server", "x", ""]);
  });

  it("is idempotent", () => {
    const once = wrapWithProxy("weather", orig);
    const twice = wrapWithProxy("weather", once);
    expect(twice).toBe(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(wrapWithProxy("other-id", once)).toBe(once);
  });

  it("recognizes an already wrapped entry however latch is spelled", () => {
    for (const command of ["latch", "/usr/local/bin/latch", "C:\\tools\\latch.cmd", "LATCH.EXE"]) {
      const entry = { command, args: ["proxy", "--server", "s", "--", "node", "x.js"] };
      expect(wrapWithProxy("s", entry), command).toBe(entry);
    }
  });

  it("launches latch the way it is told, before proxy", () => {
    const launch = { command: "/usr/bin/node", args: ["/opt/latchverify/dist/cli.js"] };
    expect(wrapWithProxy("weather", { command: "node", args: ["w.js"] }, launch)).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/latchverify/dist/cli.js", "proxy", "--server", "weather", "--", "node", "w.js"],
    });
  });

  it("launches this install by absolute path with INSTALL_LAUNCH, with the proxy's node flags first", () => {
    expect(INSTALL_LAUNCH.command).toBe(process.execPath);
    expect(PROXY_NODE_FLAGS).toEqual(["--max-semi-space-size=1"]);
    expect(INSTALL_LAUNCH.args.slice(0, -1)).toEqual(PROXY_NODE_FLAGS);
    expect(isAbsolute(INSTALL_LAUNCH.args.at(-1)!)).toBe(true);
    expect(basename(INSTALL_LAUNCH.args.at(-1)!)).toBe("cli.js");
  });

  it("recognizes a wrapped entry with or without node flags before cli.js", () => {
    const real = { command: "tsx", args: ["demo/evil-server.ts"] };
    const flagged = wrapWithProxy("weather", real, INSTALL_LAUNCH);
    expect(flagged.args!.slice(0, 2)).toEqual(["--max-semi-space-size=1", INSTALL_LAUNCH.args.at(-1)]);
    expect(wrapWithProxy("weather", flagged, INSTALL_LAUNCH)).toBe(flagged);
    expect(unwrapProxy(flagged)).toEqual(real);
    // Written before the flag existed: still recognized, never wrapped twice.
    const old = { command: process.execPath, args: [INSTALL_LAUNCH.args.at(-1)!, "proxy", "--server", "weather", "--", "tsx", "demo/evil-server.ts"] };
    expect(wrapWithProxy("weather", old, INSTALL_LAUNCH)).toBe(old);
    expect(unwrapProxy(old)).toEqual(real);
  });

  it("recognizes an entry wrapped as <node> <path>/cli.js proxy, so it is never wrapped twice", () => {
    // Regression: init wrapped this weather entry a second time.
    const entry = {
      command: "/usr/bin/node",
      args: ["/home/dev/latchverify/dist/cli.js", "proxy", "--server", "weather", "--", "tsx", "demo/evil-server.ts"],
    };
    expect(wrapWithProxy("weather", entry)).toBe(entry);
    expect(wrapWithProxy("weather", entry, INSTALL_LAUNCH)).toBe(entry);
    expect(unwrapProxy(entry)).toEqual({ command: "tsx", args: ["demo/evil-server.ts"] });
  });

  it("wraps a server whose own script is a cli.js", () => {
    const entry = { command: "node", args: ["/srv/mcp/cli.js", "serve"] };
    expect(wrapWithProxy("s", entry).args).toEqual(["proxy", "--server", "s", "--", "node", "/srv/mcp/cli.js", "serve"]);
  });

  it("wraps commands that only look like latch", () => {
    for (const entry of [
      { command: "latch", args: ["verify"] },
      { command: "latchkey", args: ["proxy"] },
      { command: "node", args: ["proxy"] },
    ]) {
      expect(wrapWithProxy("s", entry).args?.slice(0, 5), entry.command).toEqual(["proxy", "--server", "s", "--", entry.command]);
    }
  });

  it("does not mutate its input", () => {
    const entry = structuredClone(orig);
    wrapWithProxy("weather", entry);
    expect(entry).toEqual(orig);
  });

  it("keeps a parsed __proto__ key as data", () => {
    const entry = JSON.parse('{"command":"node","__proto__":{"polluted":true}}') as ClientServerEntry;
    const wrapped = wrapWithProxy("s", entry);
    expect(Object.getPrototypeOf(wrapped)).toBe(Object.prototype);
    expect(Object.hasOwn(wrapped, "__proto__")).toBe(true);
    expect(JSON.stringify(unwrapProxy(wrapped))).toBe('{"command":"node","__proto__":{"polluted":true}}');
  });

  it("rejects a server id the proxy could not parse, or an entry without a command", () => {
    expect(() => wrapWithProxy("", orig)).toThrow(TypeError);
    expect(() => wrapWithProxy("--evil", orig)).toThrow(/must be non-empty and not start with "-"/);
    expect(() => wrapWithProxy("s", { command: "" })).toThrow("has no command");
    expect(() => wrapWithProxy("s", { url: "https://x" } as unknown as ClientServerEntry)).toThrow("has no command");
  });
});

describe("proxyLaunchOf and replacesLaunch", () => {
  const launch = { command: "/usr/bin/node", args: ["--max-semi-space-size=1", "/opt/latch/dist/cli.js"] };
  const exists = (path: string) => path.startsWith("/usr/") || path.startsWith("/opt/latch/");

  it("reads the launch before proxy, for every wrapped form", () => {
    expect(proxyLaunchOf(wrapWithProxy("w", { command: "x" }, launch))).toEqual(launch);
    expect(proxyLaunchOf(wrapWithProxy("w", { command: "x" }))).toEqual({ command: "latch", args: [] });
    expect(proxyLaunchOf({ command: "x", args: ["proxy"] })).toBeUndefined();
  });

  it("replaces this install's launch when only the flags differ, never when it is already current", () => {
    expect(replacesLaunch({ command: "/usr/bin/node", args: ["/opt/latch/dist/cli.js"] }, launch, exists)).toBe(true);
    expect(replacesLaunch(launch, launch, exists)).toBe(false);
  });

  it("replaces a launch whose node or cli.js is gone, and keeps one that still works", () => {
    expect(replacesLaunch({ command: "/gone/node", args: ["/opt/latch/dist/cli.js"] }, launch, exists)).toBe(true);
    expect(replacesLaunch({ command: "/usr/bin/node", args: ["/gone/cli.js"] }, launch, exists)).toBe(true);
    expect(replacesLaunch({ command: "/usr/bin/node", args: ["/opt/latch/other/cli.js"] }, launch, exists)).toBe(false);
    // latch on PATH cannot be checked, so it is the user's choice.
    expect(replacesLaunch({ command: "latch", args: [] }, launch, exists)).toBe(false);
  });
});

describe("unwrapProxy", () => {
  it("reverses wrapWithProxy exactly (task Verify)", () => {
    const orig = { command: "node", args: ["w.js"], env: { A: "1" }, extra: true };
    const once = wrapWithProxy("weather", orig);
    expect(JSON.stringify(unwrapProxy(once))).toBe(JSON.stringify(orig));
  });

  it("round-trips entries of every shape", () => {
    const entries: ClientServerEntry[] = [
      { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      { type: "stdio", command: "uvx", args: ["mcp-server-git", "--", "x"], env: { N: "1" }, cwd: "/srv" },
      { command: "server" },
      { command: "server", env: { A: "1" } },
    ];
    for (const entry of entries) {
      expect(JSON.stringify(unwrapProxy(wrapWithProxy("s", entry))), entry.command).toBe(JSON.stringify(entry));
    }
  });

  it("restores an empty argument list as no args key", () => {
    expect(unwrapProxy(wrapWithProxy("s", { command: "server", args: [] }))).toEqual({ command: "server" });
  });

  it("returns entries that are not wrapped unchanged", () => {
    for (const entry of [
      { command: "node", args: ["x.js"] },
      { command: "latch", args: ["verify"] },
      { command: "latch", args: ["proxy", "--server", "s"] },
      { command: "latch", args: ["proxy", "--server", "s", "--"] },
      { command: "latch" },
    ]) {
      expect(unwrapProxy(entry), JSON.stringify(entry)).toBe(entry);
    }
  });

  it("unwraps an entry whose latch is given by path", () => {
    expect(unwrapProxy({ command: "/opt/bin/latch", args: ["proxy", "--server", "s", "--", "node", "x.js"] })).toEqual({
      command: "node",
      args: ["x.js"],
    });
  });

  it("does not mutate its input", () => {
    const wrapped = wrapWithProxy("s", { command: "node", args: ["x.js"] });
    const before = structuredClone(wrapped);
    unwrapProxy(wrapped);
    expect(wrapped).toEqual(before);
  });
});

/** A throwaway HOME with no XDG override, so every client path lands inside it. */
async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "latch-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  return home;
}

async function writeConfig(client: ClientId, contents: unknown): Promise<string> {
  const path = clientConfigPath(client);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  return path;
}

describe.skipIf(onWindows)("detectClients", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it("finds nothing in an empty home", async () => {
    home = await fakeHome();
    expect(await detectClients()).toEqual({ configs: [], problems: [] });
  });

  it("returns every client whose config exists, in SUPPORTED_CLIENTS order", async () => {
    home = await fakeHome();
    const weather = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };
    for (const client of [...SUPPORTED_CLIENTS].reverse()) {
      await writeConfig(client, { [mapKey(client)]: { weather }, other: 1 });
    }
    const { configs: found, problems } = await detectClients();
    expect(problems).toEqual([]);
    expect(found.map((config) => config.client)).toEqual([...SUPPORTED_CLIENTS]);
    for (const config of found) {
      expect(config.path).toBe(clientConfigPath(config.client));
      expect(config.servers).toEqual({ weather });
      expect(config.serverIds).toEqual(["weather"]);
    }
  });

  it("reads VS Code servers from servers and the others from mcpServers", async () => {
    home = await fakeHome();
    expect(SUPPORTED_CLIENTS.map(mapKey)).toEqual([
      "mcpServers",
      "mcpServers",
      "mcpServers",
      "servers",
      "servers",
      "servers",
      "mcpServers",
      "mcpServers",
      "mcpServers",
      "context_servers",
      "mcpServers",
      "mcpServers",
    ]);
    await writeConfig("vscode", { mcpServers: { a: { command: "a" } }, servers: { b: { type: "stdio", command: "b" } } });
    await writeConfig("cursor", { servers: { a: { command: "a" } }, mcpServers: { b: { command: "b" } } });
    const { configs: found } = await detectClients();
    expect(found.find((c) => c.client === "vscode")?.servers).toEqual({ b: { type: "stdio", command: "b" } });
    expect(found.find((c) => c.client === "cursor")?.servers).toEqual({ b: { command: "b" } });
  });

  it("keeps only wrappable stdio servers, and the names of all", async () => {
    home = await fakeHome();
    const mcpServers = {
      ok: { command: "node", args: ["x.js"], env: { A: "1" }, extra: true },
      typed: { type: "stdio", command: "uvx" },
      http: { type: "http", url: "https://mcp.example" },
      sse: { type: "sse", command: "x", url: "https://mcp.example/sse" },
      urlOnly: { url: "https://mcp.example" },
      emptyCommand: { command: "" },
      numericArgs: { command: "node", args: [1] },
      stringArgs: { command: "node", args: "x.js" },
      badEnv: { command: "node", env: ["A=1"] },
      notObject: "node x.js",
      nothing: null,
    };
    await writeConfig("claude-desktop", { mcpServers });
    const [config] = (await detectClients()).configs;
    expect(config!.servers).toEqual({ ok: mcpServers.ok, typed: mcpServers.typed });
    expect(config!.serverIds).toEqual(Object.keys(mcpServers));
  });

  it("detects a config without servers, with an empty server map", async () => {
    home = await fakeHome();
    await writeConfig("cursor", { theme: "dark" });
    expect((await detectClients()).configs.map((c) => [c.client, c.servers])).toEqual([["cursor", {}]]);
  });

  it("reads JSONC: comments and trailing commas", async () => {
    home = await fakeHome();
    await writeConfig("vscode", '{\n  // mine\n  "servers": {\n    "a": { "type": "stdio", "command": "a", }, /* b */\n  },\n}\n');
    expect((await detectClients()).configs.map((c) => [c.client, c.servers])).toEqual([["vscode", { a: { type: "stdio", command: "a" } }]]);
  });

  it("reports files it cannot use instead of skipping them silently", async () => {
    home = await fakeHome();
    await writeConfig("claude-desktop", "{ not json");
    await writeConfig("claude-code", "[1, 2]");
    await writeConfig("cursor", { mcpServers: [] });
    await writeConfig("vscode", "");
    expect(await detectClients()).toEqual({
      configs: [],
      problems: [
        { client: "claude-desktop", path: clientConfigPath("claude-desktop"), message: "is not valid JSON: InvalidSymbol at line 1, column 3" },
        { client: "claude-code", path: clientConfigPath("claude-code"), message: "is not a JSON object" },
        { client: "cursor", path: clientConfigPath("cursor"), message: 'keeps "mcpServers" as something other than an object' },
        { client: "vscode", path: clientConfigPath("vscode"), message: "is not valid JSON: ValueExpected at line 1, column 1" },
      ],
    });
  });

  it("reports a config path it cannot read", async () => {
    home = await fakeHome();
    await mkdir(clientConfigPath("cursor"), { recursive: true });
    expect(await detectClients()).toEqual({ configs: [], problems: [{ client: "cursor", path: clientConfigPath("cursor"), message: "cannot be read (EISDIR)" }] });
  });

  it("reads Claude Code's per-project servers as one more config per project", async () => {
    home = await fakeHome();
    const user = { a: { command: "a" } };
    const app = { b: { command: "b" }, remote: { type: "http", url: "https://mcp.example" } };
    await writeConfig("claude-code", { mcpServers: user, projects: { "/srv/app": { mcpServers: app }, "/srv/empty": { mcpServers: {} }, "/srv/none": {} } });
    const { configs, problems } = await detectClients();
    expect(problems).toEqual([]);
    expect(configs.map(({ client, serversPath, scope, servers }) => ({ client, serversPath, scope, servers }))).toEqual([
      { client: "claude-code", serversPath: ["mcpServers"], scope: undefined, servers: user },
      { client: "claude-code", serversPath: ["projects", "/srv/app", "mcpServers"], scope: "project /srv/app", servers: { b: { command: "b" } } },
    ]);
  });

  it("reports a Claude Code project whose servers are not an object, and still reads the rest", async () => {
    home = await fakeHome();
    await writeConfig("claude-code", { mcpServers: { a: { command: "a" } }, projects: { "/srv/app": { mcpServers: ["x"] } } });
    const { configs, problems } = await detectClients();
    expect(configs.map((config) => config.serversPath)).toEqual([["mcpServers"]]);
    expect(problems).toEqual([{ client: "claude-code", path: clientConfigPath("claude-code"), message: 'keeps "projects./srv/app.mcpServers" as something other than an object' }]);
  });

  it("accepts a leading byte-order mark", async () => {
    home = await fakeHome();
    await writeConfig("cursor", `\uFEFF${JSON.stringify({ mcpServers: { a: { command: "a" } } })}`);
    expect((await detectClients()).configs[0]?.servers).toEqual({ a: { command: "a" } });
  });

  it("keeps a server named __proto__ as a plain key", async () => {
    home = await fakeHome();
    await writeConfig("cursor", '{"mcpServers":{"__proto__":{"command":"node"}}}');
    const [config] = (await detectClients()).configs;
    expect(Object.hasOwn(config!.servers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(config!.servers)).toBe(Object.prototype);
  });
});

/** Each client's documented example config: tests/fixtures/clients/<client>/<file name>. */
const fixture = (client: ClientId, path: string): string =>
  fileURLToPath(new URL(`../fixtures/clients/${client}/${basename(path)}`, import.meta.url));

/** The stdio servers each fixture holds, per file: the ones latch wraps. */
const FIXTURE_SERVERS: Record<ClientId, string[][]> = {
  "claude-desktop": [["filesystem"]],
  "claude-code": [["airtable"], ["database-tools"]],
  cursor: [["server-name"]],
  vscode: [["Perplexity", "fetch"]],
  "vscode-insiders": [["Perplexity", "fetch"]],
  vscodium: [["Perplexity", "fetch"]],
  cline: [["my-server"]],
  "cline-cli": [["my-server"]],
  "gemini-cli": [["pythonTools"]],
  zed: [["local-mcp-server"]],
  "lm-studio": [["time"]],
  "amazon-q": [["awslabs.aws-documentation-mcp-server"], ["git"]],
};

describe.skipIf(onWindows)("every supported client, on its documented example config", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it("has a fixture for each of its config files", async () => {
    for (const client of SUPPORTED_CLIENTS) {
      for (const location of clientLocations(client)) {
        await expect(stat(fixture(client, location.path)), `${client}: ${basename(location.path)}`).resolves.toBeDefined();
      }
    }
    expect(Object.keys(FIXTURE_SERVERS).sort()).toEqual([...SUPPORTED_CLIENTS].sort());
  });

  it("is detected, wrapped and unwrapped, keeping every comment and every other entry", async () => {
    home = await fakeHome();
    const originals = new Map<string, string>();
    for (const client of SUPPORTED_CLIENTS) {
      for (const location of clientLocations(client)) {
        const text = await readFile(fixture(client, location.path), "utf8");
        await mkdir(dirname(location.path), { recursive: true });
        await writeFile(location.path, text);
        originals.set(location.path, text);
      }
    }

    const { configs, problems } = await detectClients();
    expect(problems).toEqual([]);
    for (const client of SUPPORTED_CLIENTS) {
      expect(configs.filter((config) => config.client === client).map((config) => Object.keys(config.servers)), client).toEqual(FIXTURE_SERVERS[client]);
    }

    for (const config of configs) await writeClientConfig({ ...config, servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => [id, wrapWithProxy(id, entry)])) });
    const wrapped = (await detectClients()).configs;
    for (const config of wrapped) {
      for (const entry of Object.values(config.servers)) expect(entry.args?.[0], config.path).toBe("proxy");
      await writeClientConfig({ ...config, servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => [id, unwrapProxy(entry)])) });
    }

    let checkedComments = 0;
    for (const config of configs) {
      const original = originals.get(config.path)!;
      const restored = await readFile(config.path, "utf8");
      // Comments in the fixtures start their line or are /* blocks */, so no URL inside a string is mistaken for one.
      const comments = original.match(/^[ \t]*\/\/.*$|\/\*[\s\S]*?\*\//gm) ?? [];
      for (const comment of comments) expect(restored, config.path).toContain(comment.trim());
      checkedComments += comments.length;
      // unwrapProxy gives back `args: []` as no args key; clients treat the two the same.
      const dropEmptyArgs = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === "args" && Array.isArray(v) && v.length === 0 ? undefined : v)));
      expect(parseJsonc(restored), config.path).toEqual({ ok: true, value: dropEmptyArgs((parseJsonc(original) as { value: unknown }).value) });
    }
    // VS Code's three fixtures carry 3 comments each, Zed's 4.
    expect(checkedComments).toBe(13);
  });
});

describe.skipIf(onWindows)("writeClientConfig", () => {
  let home: string;
  const weather = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };

  afterEach(async () => {
    vi.useRealTimers();
    await rm(home, { recursive: true, force: true });
  });

  /** Write `contents` as Claude Desktop's config and detect it. */
  async function detected(contents: unknown, client: ClientId = "claude-desktop"): Promise<ClientConfig> {
    home = await fakeHome();
    await writeConfig(client, contents);
    const config = (await detectClients()).configs.find((c) => c.client === client);
    if (config === undefined) throw new Error("config not detected");
    return config;
  }

  const wrapAll = (config: ClientConfig): ClientConfig => ({
    ...config,
    servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => [id, wrapWithProxy(id, entry)])),
  });

  const filesBeside = async (path: string) => (await readdir(dirname(path))).sort();

  it("wraps the servers, keeps unknown keys and makes no copy of the file, which holds the user's keys", async () => {
    const config = await detected({ mcpServers: { weather }, other: 1 });
    await writeClientConfig(wrapAll(config));
    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({ mcpServers: { weather: wrapWithProxy("weather", weather) }, other: 1 });
    expect(await filesBeside(config.path)).toEqual(["claude_desktop_config.json"]);
  });

  it("changes only command and args, never an env variable or another key of the entry", async () => {
    const keyed = { command: "npx", args: ["-y", "server"], env: { API_KEY: "sk-secret", OTHER: "x" }, disabled: false };
    const text = `{\n  "mcpServers": {\n    "keyed": {\n      "command": "npx",\n      "args": ["-y", "server"],\n      "env": { "API_KEY": "sk-secret",   "OTHER": "x" },\n      "disabled": false\n    }\n  }\n}\n`;
    const config = await detected(text);
    await writeClientConfig({ ...config, servers: { keyed: wrapWithProxy("keyed", keyed, { command: "/n", args: ["/cli.js"] }, { lockfilePath: "/l", stateDir: "/s" }) } });
    const written = await readFile(config.path, "utf8");
    // The env line is byte for byte the user's, odd spacing included.
    expect(written).toContain('      "env": { "API_KEY": "sk-secret",   "OTHER": "x" },\n      "disabled": false\n');
    expect(JSON.parse(written).mcpServers.keyed.args).toEqual(["/cli.js", "--lockfile", "/l", "--state-dir", "/s", "proxy", "--server", "keyed", "--", "npx", "-y", "server"]);
  });

  it("removes only LatchVerify's own variables from an entry written by an older version", async () => {
    const old = { command: "latch", args: ["proxy", "--server", "w", "--", "npx", "w"], env: { API_KEY: "sk-secret", LATCH_LOCKFILE_PATH: "/l", LATCH_STATE_DIR: "/s" } };
    const config = await detected({ mcpServers: { w: old } });
    await writeClientConfig({ ...config, servers: { w: withoutLatchEnv(old) } });
    expect(JSON.parse(await readFile(config.path, "utf8")).mcpServers.w).toEqual({ command: "latch", args: old.args, env: { API_KEY: "sk-secret" } });
  });

  it("is a no-op when nothing changes", async () => {
    const config = wrapAll(await detected({ mcpServers: { weather }, other: 1 }));
    await writeClientConfig(config);
    const after = await readFile(config.path, "utf8");
    await writeClientConfig(wrapAll((await detectClients()).configs[0]!));
    expect(await readFile(config.path, "utf8")).toBe(after);
  });

  it("does not reformat a hand-formatted file when nothing changes", async () => {
    const config = await detected('{"mcpServers": {"weather": {"command": "npx", "args": ["tsx", "demo/weather-server.ts"]}}}');
    await writeClientConfig(config);
    expect(await readFile(config.path, "utf8")).toBe('{"mcpServers": {"weather": {"command": "npx", "args": ["tsx", "demo/weather-server.ts"]}}}');
  });

  it("keeps servers it was not given, including HTTP servers", async () => {
    const http = { type: "http", url: "https://mcp.example" };
    const config = await detected({ mcpServers: { weather, other: { command: "x" }, http } });
    await writeClientConfig({ ...config, servers: { weather: wrapWithProxy("weather", weather) } });
    expect(JSON.parse(await readFile(config.path, "utf8")).mcpServers).toEqual({
      weather: wrapWithProxy("weather", weather),
      other: { command: "x" },
      http,
    });
  });

  it("keeps changes the client made to the file after detection", async () => {
    const config = await detected({ mcpServers: { weather }, numStartups: 1 });
    await writeFile(config.path, JSON.stringify({ mcpServers: { weather }, numStartups: 2, added: true }));
    await writeClientConfig(wrapAll(config));
    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({
      mcpServers: { weather: wrapWithProxy("weather", weather) },
      numStartups: 2,
      added: true,
    });
  });

  it("refuses to rewrite a file that stopped being JSON, leaving it as is", async () => {
    const config = await detected({ mcpServers: { weather } });
    await writeFile(config.path, "{ half written");
    await expect(writeClientConfig(wrapAll(config))).rejects.toThrow(`${config.path} is no longer a JSON object; not rewriting it`);
    expect(await readFile(config.path, "utf8")).toBe("{ half written");
    expect(await filesBeside(config.path)).toEqual(["claude_desktop_config.json"]);
  });

  it("creates the file with just these servers, mode 0600, when it is gone", async () => {
    const config = await detected({ mcpServers: { weather }, other: 1 });
    await rm(dirname(config.path), { recursive: true });
    await writeClientConfig(wrapAll(config));
    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({ mcpServers: { weather: wrapWithProxy("weather", weather) } });
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect(await filesBeside(config.path)).toEqual(["claude_desktop_config.json"]);
  });

  it("writes VS Code servers under servers", async () => {
    const config = await detected({ servers: { weather: { type: "stdio", ...weather } }, inputs: [] }, "vscode");
    await writeClientConfig(wrapAll(config));
    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({
      servers: { weather: wrapWithProxy("weather", { type: "stdio", ...weather }) },
      inputs: [],
    });
  });

  it("keeps the file's indentation, line endings and final newline", async () => {
    const cases: Array<[string, (text: string) => boolean]> = [
      ['{\n\t"mcpServers": {\n\t\t"weather": {"command": "a"}\n\t}\n}\n', (t) => t.startsWith('{\n\t"mcpServers"') && t.endsWith("}\n")],
      ['{\n    "mcpServers": {"weather": {"command": "a"}}\n}', (t) => t.startsWith('{\n    "mcpServers"') && t.endsWith("}")],
      ['{\r\n  "mcpServers": {"weather": {"command": "a"}}\r\n}\r\n', (t) => !/[^\r]\n/.test(t) && t.endsWith("}\r\n")],
    ];
    for (const [text, check] of cases) {
      const config = await detected(text);
      await writeClientConfig(wrapAll(config));
      const written = await readFile(config.path, "utf8");
      expect(check(written), JSON.stringify(written)).toBe(true);
      expect(JSON.parse(written).mcpServers.weather.command).toBe("latch");
      await rm(home, { recursive: true, force: true });
    }
  });

  it("edits a JSONC config in place: comments, trailing commas and other entries survive byte for byte", async () => {
    const original = `{
  // Servers for this machine.
  "servers": {
    "weather": { "type": "stdio", "command": "npx", "args": ["tsx", "demo/weather-server.ts"] },
    /* remote one, not wrapped */
    "remote": { "type": "http", "url": "https://mcp.example", },
  },
  "inputs": [],
}
`;
    const config = await detected(original, "vscode");
    await writeClientConfig(wrapAll(config));
    const written = await readFile(config.path, "utf8");
    // Only the values of command and args are replaced; the entry keeps its own one-line layout.
    expect(written).toBe(`{
  // Servers for this machine.
  "servers": {
    "weather": { "type": "stdio", "command": "latch", "args": [
        "proxy",
        "--server",
        "weather",
        "--",
        "npx",
        "tsx",
        "demo/weather-server.ts"
      ] },
    /* remote one, not wrapped */
    "remote": { "type": "http", "url": "https://mcp.example", },
  },
  "inputs": [],
}
`);
    expect(await filesBeside(config.path)).toEqual(["mcp.json"]);
  });

  it("writes a Claude Code project's servers under that project only", async () => {
    home = await fakeHome();
    const path = await writeConfig("claude-code", { mcpServers: { weather }, projects: { "/srv/app": { mcpServers: { weather }, allowedTools: [] } } });
    const project = (await detectClients()).configs.find((config) => config.scope === "project /srv/app")!;
    await writeClientConfig(wrapAll(project));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { weather },
      projects: { "/srv/app": { mcpServers: { weather: wrapWithProxy("weather", weather) }, allowedTools: [] } },
    });
  });

  it("refuses to rewrite a file whose server map stopped being an object", async () => {
    const config = await detected({ mcpServers: { weather } });
    await writeFile(config.path, '{"mcpServers": "gone"}');
    await expect(writeClientConfig(wrapAll(config))).rejects.toThrow(`${config.path} no longer keeps "mcpServers" as an object; not rewriting it`);
    expect(await readFile(config.path, "utf8")).toBe('{"mcpServers": "gone"}');
  });

  it("keeps the original permissions on the new file", async () => {
    const config = await detected({ mcpServers: { weather }, token: "secret" });
    await chmod(config.path, 0o600);
    await writeClientConfig(wrapAll(config));
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
  });

  it("rewrites the target of a symlinked config and keeps the link", async () => {
    const config = await detected({ mcpServers: { weather } });
    const real = join(home, "dotfiles", "claude.json");
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, await readFile(config.path, "utf8"));
    await rm(config.path);
    await symlink(real, config.path);
    await writeClientConfig(wrapAll(config));
    expect((await lstat(config.path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).mcpServers.weather.command).toBe("latch");
  });
});
