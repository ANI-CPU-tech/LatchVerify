import { describe, expect, it } from "vitest";
import { collectServers } from "../../src/commands/init.js";
import { wrapWithProxy, type ClientConfig, type ClientId, type ClientServerEntry } from "../../src/config/clients.js";

const config = (client: ClientId, servers: Record<string, ClientServerEntry>): ClientConfig => ({
  client,
  path: `/fake/${client}.json`,
  servers,
  raw: { mcpServers: servers },
});

const weather: ClientServerEntry = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };

describe("collectServers", () => {
  it("returns every stdio server, sorted by id, with its clients", () => {
    const { servers, skipped } = collectServers([
      config("claude-desktop", { weather, git: { command: "uvx", args: ["mcp-server-git"], env: { A: "1" } } }),
      config("cursor", { weather: { ...weather, extra: true } }),
    ]);
    expect(skipped).toEqual([]);
    expect(servers).toEqual([
      { serverId: "git", command: "uvx", args: ["mcp-server-git"], env: { A: "1" }, clients: ["claude-desktop"] },
      { serverId: "weather", command: "npx", args: ["tsx", "demo/weather-server.ts"], env: {}, clients: ["claude-desktop", "cursor"] },
    ]);
  });

  it("recovers the real command of an entry that already runs latch proxy", () => {
    const wrapped = { ...wrapWithProxy("weather", weather), env: { LATCH_LOCKFILE_PATH: "/repo/latch.lock" } };
    const { servers } = collectServers([config("claude-desktop", { weather: wrapped }), config("cursor", { weather })]);
    expect(servers).toEqual([
      {
        serverId: "weather",
        command: "npx",
        args: ["tsx", "demo/weather-server.ts"],
        env: { LATCH_LOCKFILE_PATH: "/repo/latch.lock" },
        clients: ["claude-desktop", "cursor"],
      },
    ]);
  });

  it("treats a missing args list like an empty one", () => {
    const { servers } = collectServers([config("cursor", { s: { command: "server" } }), config("vscode", { s: { command: "server", args: [] } })]);
    expect(servers).toEqual([{ serverId: "s", command: "server", args: [], env: {}, clients: ["cursor", "vscode"] }]);
  });

  it("converts VS Code env values to strings and drops null ones", () => {
    const entry = { command: "server", env: { PORT: 8080, DEBUG: true, NAME: "x", UNSET: null, NESTED: { a: 1 } } } as unknown as ClientServerEntry;
    expect(collectServers([config("vscode", { s: entry })]).servers[0]!.env).toEqual({ PORT: "8080", DEBUG: "true", NAME: "x" });
  });

  it("keeps an env variable named __proto__ as plain data", () => {
    const entry = JSON.parse('{"command":"server","env":{"__proto__":"x","A":"1"}}') as ClientServerEntry;
    const { env } = collectServers([config("cursor", { s: entry })]).servers[0]!;
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.keys(env)).toEqual(["__proto__", "A"]);
  });

  it("skips an id that clients launch differently", () => {
    const { servers, skipped } = collectServers([
      config("claude-desktop", { weather }),
      config("cursor", { weather: { command: "npx", args: ["tsx", "other.ts"] } }),
      config("vscode", { weather }),
    ]);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([
      {
        serverId: "weather",
        clients: ["claude-desktop", "cursor", "vscode"],
        reason: "claude-desktop, cursor and vscode launch it with different commands; give one of them another name",
      },
    ]);
  });

  it("skips an id latch proxy --server cannot take", () => {
    const { servers, skipped } = collectServers([config("cursor", { "": weather, "-x": weather, ok: weather })]);
    expect(servers.map((s) => s.serverId)).toEqual(["ok"]);
    expect(skipped.map((s) => [s.serverId, s.reason])).toEqual([
      ["", 'cannot wrap server "": the id must be non-empty and not start with "-"'],
      ["-x", 'cannot wrap server "-x": the id must be non-empty and not start with "-"'],
    ]);
  });

  it("skips a wrapped entry whose real command is missing", () => {
    const broken = { command: "latch", args: ["proxy", "--server", "weather"] };
    const { servers, skipped } = collectServers([config("cursor", { weather: broken })]);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ serverId: "weather", clients: ["cursor"], reason: "it runs latch proxy, but its real command cannot be recovered" }]);
  });

  it("returns nothing for configs without servers", () => {
    expect(collectServers([config("cursor", {})])).toEqual({ servers: [], skipped: [] });
  });
});
