import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_LAUNCH,
  PROXY_COMMAND,
  SUPPORTED_CLIENTS,
  clientConfigPath,
  detectClients,
  serversKey,
  unwrapProxy,
  wrapWithProxy,
  writeClientConfig,
  type ClientConfig,
  type ClientId,
  type ClientServerEntry,
} from "../../src/config/clients.js";

// os.homedir() follows HOME only on POSIX hosts.
const onWindows = process.platform === "win32";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientConfigPath", () => {
  it.skipIf(onWindows)("uses the documented locations on Linux", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(SUPPORTED_CLIENTS.map((client) => clientConfigPath(client, "linux"))).toEqual([
      "/home/dev/.config/Claude/claude_desktop_config.json",
      "/home/dev/.claude.json",
      "/home/dev/.cursor/mcp.json",
      "/home/dev/.config/Code/User/mcp.json",
    ]);
  });

  it.skipIf(onWindows)("honours an absolute XDG_CONFIG_HOME on Linux and ignores a relative one", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/data/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/data/config/Claude/claude_desktop_config.json");
    expect(clientConfigPath("vscode", "linux")).toBe("/data/config/Code/User/mcp.json");
    expect(clientConfigPath("cursor", "linux")).toBe("/home/dev/.cursor/mcp.json");
    vi.stubEnv("XDG_CONFIG_HOME", "relative/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/home/dev/.config/Claude/claude_desktop_config.json");
  });

  it.skipIf(onWindows)("uses Application Support on macOS", () => {
    vi.stubEnv("HOME", "/Users/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/ignored");
    expect(SUPPORTED_CLIENTS.map((client) => clientConfigPath(client, "darwin"))).toEqual([
      "/Users/dev/Library/Application Support/Claude/claude_desktop_config.json",
      "/Users/dev/.claude.json",
      "/Users/dev/.cursor/mcp.json",
      "/Users/dev/Library/Application Support/Code/User/mcp.json",
    ]);
  });

  it.skipIf(onWindows)("uses %APPDATA% and Windows separators on Windows", () => {
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming");
    expect(clientConfigPath("claude-desktop", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(clientConfigPath("vscode", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\mcp.json");
    expect(clientConfigPath("cursor", "win32").endsWith("\\.cursor\\mcp.json")).toBe(true);
    expect(clientConfigPath("claude-code", "win32").endsWith("\\.claude.json")).toBe(true);
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
    expect(() => clientConfigPath("zed" as ClientId)).toThrow('unknown MCP client "zed"');
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

  it("launches this install by absolute path with INSTALL_LAUNCH", () => {
    expect(INSTALL_LAUNCH.command).toBe(process.execPath);
    expect(INSTALL_LAUNCH.args).toHaveLength(1);
    expect(isAbsolute(INSTALL_LAUNCH.args[0]!)).toBe(true);
    expect(basename(INSTALL_LAUNCH.args[0]!)).toBe("cli.js");
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
      await writeConfig(client, { [serversKey(client)]: { weather }, other: 1 });
    }
    const { configs: found, problems } = await detectClients();
    expect(problems).toEqual([]);
    expect(found.map((config) => config.client)).toEqual([...SUPPORTED_CLIENTS]);
    for (const config of found) {
      expect(config.path).toBe(clientConfigPath(config.client));
      expect(config.servers).toEqual({ weather });
      expect(config.raw).toEqual({ [serversKey(config.client)]: { weather }, other: 1 });
    }
  });

  it("reads VS Code servers from servers and the others from mcpServers", async () => {
    home = await fakeHome();
    expect(SUPPORTED_CLIENTS.map(serversKey)).toEqual(["mcpServers", "mcpServers", "mcpServers", "servers"]);
    await writeConfig("vscode", { mcpServers: { a: { command: "a" } }, servers: { b: { type: "stdio", command: "b" } } });
    await writeConfig("cursor", { servers: { a: { command: "a" } }, mcpServers: { b: { command: "b" } } });
    const { configs: found } = await detectClients();
    expect(found.find((c) => c.client === "vscode")?.servers).toEqual({ b: { type: "stdio", command: "b" } });
    expect(found.find((c) => c.client === "cursor")?.servers).toEqual({ b: { command: "b" } });
  });

  it("keeps only wrappable stdio servers, leaving the rest in raw", async () => {
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
    expect(config!.raw).toEqual({ mcpServers });
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

describe.skipIf(onWindows)("writeClientConfig", () => {
  let home: string;
  const weather = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };
  const BACKUP = /\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?\.bak$/;

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
  const backups = async (path: string) => (await filesBeside(path)).filter((name) => BACKUP.test(name));

  it("wraps the servers, keeps unknown keys and leaves one .bak with the original bytes", async () => {
    const original = { mcpServers: { weather }, other: 1 };
    const config = await detected(original);
    const before = await readFile(config.path, "utf8");
    await writeClientConfig(wrapAll(config));

    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({ mcpServers: { weather: wrapWithProxy("weather", weather) }, other: 1 });
    const [backup, ...more] = await backups(config.path);
    expect(more).toEqual([]);
    expect(backup!.startsWith("claude_desktop_config.json.")).toBe(true);
    expect(await readFile(join(dirname(config.path), backup!), "utf8")).toBe(before);
    expect(await filesBeside(config.path)).toEqual(["claude_desktop_config.json", backup]);
  });

  it("is a no-op, with no new backup, when nothing changes", async () => {
    const config = wrapAll(await detected({ mcpServers: { weather }, other: 1 }));
    await writeClientConfig(config);
    const after = await readFile(config.path, "utf8");
    await writeClientConfig(wrapAll((await detectClients()).configs[0]!));
    expect(await readFile(config.path, "utf8")).toBe(after);
    expect(await backups(config.path)).toHaveLength(1);
  });

  it("does not reformat a hand-formatted file when nothing changes", async () => {
    const config = await detected('{"mcpServers": {"weather": {"command": "npx", "args": ["tsx", "demo/weather-server.ts"]}}}');
    await writeClientConfig(config);
    expect(await readFile(config.path, "utf8")).toBe('{"mcpServers": {"weather": {"command": "npx", "args": ["tsx", "demo/weather-server.ts"]}}}');
    expect(await backups(config.path)).toEqual([]);
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

  it("writes from config.raw, with no backup and mode 0600, when the file is gone", async () => {
    const config = await detected({ mcpServers: { weather }, other: 1 });
    await rm(dirname(config.path), { recursive: true });
    await writeClientConfig(wrapAll(config));
    expect(JSON.parse(await readFile(config.path, "utf8"))).toEqual({ mcpServers: { weather: wrapWithProxy("weather", weather) }, other: 1 });
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
    const wrapped = wrapWithProxy("weather", { type: "stdio", ...weather });
    expect(written).toBe(`{
  // Servers for this machine.
  "servers": {
    "weather": ${JSON.stringify(wrapped, null, 2).replace(/\n/g, "\n    ")},
    /* remote one, not wrapped */
    "remote": { "type": "http", "url": "https://mcp.example", },
  },
  "inputs": [],
}
`);
    const [backup] = await backups(config.path);
    expect(await readFile(join(dirname(config.path), backup!), "utf8")).toBe(original);
  });

  it("refuses to rewrite a file whose server map stopped being an object", async () => {
    const config = await detected({ mcpServers: { weather } });
    await writeFile(config.path, '{"mcpServers": "gone"}');
    await expect(writeClientConfig(wrapAll(config))).rejects.toThrow(`${config.path} no longer keeps "mcpServers" as an object; not rewriting it`);
    expect(await readFile(config.path, "utf8")).toBe('{"mcpServers": "gone"}');
  });

  it("keeps the original permissions on the new file and the backup", async () => {
    const config = await detected({ mcpServers: { weather }, token: "secret" });
    await chmod(config.path, 0o600);
    await writeClientConfig(wrapAll(config));
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    const [backup] = await backups(config.path);
    expect((await stat(join(dirname(config.path), backup!))).mode & 0o777).toBe(0o600);
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

  it("never overwrites an earlier backup taken in the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T09:00:00.000Z"));
    const config = await detected({ mcpServers: { weather } });
    await writeClientConfig(wrapAll(config));
    await writeClientConfig({ ...config, servers: { weather: { command: "other" } } });
    expect(await backups(config.path)).toEqual([
      "claude_desktop_config.json.2026-10-23T09-00-00-000Z-1.bak",
      "claude_desktop_config.json.2026-10-23T09-00-00-000Z.bak",
    ]);
  });
});
