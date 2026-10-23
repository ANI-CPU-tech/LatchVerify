import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_COMMAND,
  SUPPORTED_CLIENTS,
  clientConfigPath,
  detectClients,
  serversKey,
  unwrapProxy,
  wrapWithProxy,
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
    expect(await detectClients()).toEqual([]);
  });

  it("returns every client whose config exists, in SUPPORTED_CLIENTS order", async () => {
    home = await fakeHome();
    const weather = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };
    for (const client of [...SUPPORTED_CLIENTS].reverse()) {
      await writeConfig(client, { [serversKey(client)]: { weather }, other: 1 });
    }
    const found = await detectClients();
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
    const found = await detectClients();
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
    const [config] = await detectClients();
    expect(config!.servers).toEqual({ ok: mcpServers.ok, typed: mcpServers.typed });
    expect(config!.raw).toEqual({ mcpServers });
  });

  it("detects a config without servers, with an empty server map", async () => {
    home = await fakeHome();
    await writeConfig("cursor", { theme: "dark" });
    await writeConfig("claude-code", { mcpServers: [] });
    expect((await detectClients()).map((c) => [c.client, c.servers])).toEqual([
      ["claude-code", {}],
      ["cursor", {}],
    ]);
  });

  it("skips files that are not one JSON object, including JSONC", async () => {
    home = await fakeHome();
    await writeConfig("claude-desktop", "{ not json");
    await writeConfig("claude-code", "[1, 2]");
    await writeConfig("cursor", '{\n  // comment\n  "mcpServers": {}\n}');
    await writeConfig("vscode", "");
    expect(await detectClients()).toEqual([]);
  });

  it("skips a config path that is a directory", async () => {
    home = await fakeHome();
    await mkdir(clientConfigPath("cursor"), { recursive: true });
    expect(await detectClients()).toEqual([]);
  });

  it("accepts a leading byte-order mark", async () => {
    home = await fakeHome();
    await writeConfig("cursor", `\uFEFF${JSON.stringify({ mcpServers: { a: { command: "a" } } })}`);
    expect((await detectClients())[0]?.servers).toEqual({ a: { command: "a" } });
  });

  it("keeps a server named __proto__ as a plain key", async () => {
    home = await fakeHome();
    await writeConfig("cursor", '{"mcpServers":{"__proto__":{"command":"node"}}}');
    const [config] = await detectClients();
    expect(Object.hasOwn(config!.servers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(config!.servers)).toBe(Object.prototype);
  });
});
