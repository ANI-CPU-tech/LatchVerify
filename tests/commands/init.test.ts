import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectServers, runInit, type InitOptions } from "../../src/commands/init.js";
import { LockFileSchema, type LockFile } from "../../src/schema/index.js";
import { LockfileError, emptyLockfile } from "../../src/store/lockfile.js";
import { INSTALL_LAUNCH, clientConfigPath, wrapWithProxy, type ClientConfig, type ClientId, type ClientServerEntry } from "../../src/config/clients.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Absolute, so children started outside the repo still find tsx.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const example = (): LockFile => LockFileSchema.parse(JSON.parse(readFileSync(join(root, "latch.lock.example"), "utf8")));

const config = (client: ClientId, servers: Record<string, ClientServerEntry>): ClientConfig => ({
  client,
  path: `/fake/${client}.json`,
  serversPath: ["mcpServers"],
  servers,
  serverIds: Object.keys(servers),
});

const weather: ClientServerEntry = { command: "npx", args: ["tsx", "demo/weather-server.ts"] };

describe("collectServers", () => {
  it("returns every stdio server, sorted by id, with its clients", () => {
    const { servers, skipped } = collectServers([
      config("claude-desktop", { weather, git: { command: "uvx", args: ["mcp-server-git"], envNames: ["A"] } }),
      config("cursor", { weather: { ...weather } }),
    ]);
    expect(skipped).toEqual([]);
    expect(servers).toEqual([
      { serverId: "git", command: "uvx", args: ["mcp-server-git"], clients: ["claude-desktop"] },
      { serverId: "weather", command: "npx", args: ["tsx", "demo/weather-server.ts"], clients: ["claude-desktop", "cursor"] },
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
        clients: ["claude-desktop", "cursor"],
      },
    ]);
  });

  it("treats a missing args list like an empty one", () => {
    const { servers } = collectServers([config("cursor", { s: { command: "server" } }), config("vscode", { s: { command: "server", args: [] } })]);
    expect(servers).toEqual([{ serverId: "s", command: "server", args: [], clients: ["cursor", "vscode"] }]);
  });

  it("never copies an entry's env, which holds the server's keys", () => {
    const entry = { command: "server", env: { API_KEY: "sk-secret" } };
    expect(JSON.stringify(collectServers([config("cursor", { s: entry })]))).not.toContain("sk-secret");
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

describe.skipIf(process.platform === "win32")("runInit", { timeout: 30_000 }, () => {
  let home: string;
  let lockfilePath: string;
  const weatherEntry = { command: process.execPath, args: ["--import", tsx, join(root, "demo/weather-server.ts")] };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-init-"));
    lockfilePath = join(home, "repo", "latch.lock");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(client: ClientId, contents: unknown): Promise<string> {
    const path = clientConfigPath(client);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(contents, null, 2));
    return path;
  }

  /** Run init and return its exit code and output, without ANSI colours. */
  async function init(options: Partial<InitOptions> = {}) {
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    const code = await runInit({ dryRun: false, lockfilePath, output, ...options });
    return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  const files = async (path: string) => (await readdir(dirname(path))).sort();
  const lockOnDisk = async () => LockFileSchema.parse(JSON.parse(await readFile(lockfilePath, "utf8")));
  const paths = () => ({ lockfilePath, stateDir: join(home, "repo", ".latch") });
  const expectedEntry = (entry: ClientServerEntry, serverId = "weather") => wrapWithProxy(serverId, entry, INSTALL_LAUNCH, paths());

  it("dry run plans everything and writes nothing (task Verify)", async () => {
    const config = await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry }, other: 1 });
    const before = await readFile(config, "utf8");
    const { code, text } = await init({ client: "claude-desktop", dryRun: true });
    expect(code).toBe(0);
    expect(text).toContain("(dry run: nothing is written)");
    expect(text).toContain("✔ weather: would link; its tools are pinned the first time claude-desktop starts it");
    expect(text).toContain(`would write ${lockfilePath} with 1 server`);
    expect(text).toContain(`would rewrite ${config}:`);
    expect(text).toContain(`  weather: ${[INSTALL_LAUNCH.command, ...INSTALL_LAUNCH.args].join(" ")} --lockfile ${lockfilePath} --state-dir ${join(home, "repo", ".latch")} proxy --server weather -- `);
    expect(await readFile(config, "utf8")).toBe(before);
    expect(await files(config)).toEqual(["claude_desktop_config.json"]);
    await expect(readdir(join(home, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("links the server to be pinned on its first run, wraps it, keeps other keys and makes no copy of the config (task Verify)", async () => {
    const config = await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry }, other: 1 });
    const { code, text } = await init({ client: "claude-desktop" });
    expect(code).toBe(0);
    expect(text).toContain("✔ weather: linked; its tools are pinned the first time claude-desktop starts it");
    expect(text).toContain(`✔ wrote ${lockfilePath}`);
    expect(text).toContain(`next: commit ${lockfilePath}`);
    expect(text).toContain("next: restart claude-desktop");

    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ mcpServers: { weather: expectedEntry(weatherEntry) }, other: 1 });
    expect(await files(config)).toEqual(["claude_desktop_config.json"]);

    expect((await lockOnDisk()).servers.weather).toEqual({ transport: "stdio", command: weatherEntry.command, args: weatherEntry.args, tools: [], trustOnFirstUse: true });
  });

  it("writes an explicit state directory into the wrapped entry's args, never its env", async () => {
    const config = await writeConfig("claude-desktop", { mcpServers: { weather: { ...weatherEntry, env: { KEY: "secret" } } } });
    const stateDir = join(home, "state");
    expect((await init({ client: "claude-desktop", stateDir })).code).toBe(0);
    const entry = JSON.parse(await readFile(config, "utf8")).mcpServers.weather as { args: string[]; env: unknown };
    expect(entry.args).toEqual(expect.arrayContaining(["--lockfile", lockfilePath, "--state-dir", stateDir]));
    expect(entry.env).toEqual({ KEY: "secret" });
  });

  it("changes nothing when run a second time (task Verify)", async () => {
    const config = await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry }, other: 1 });
    await init();
    const [configAfter, lockAfter, filesAfter] = [await readFile(config, "utf8"), await readFile(lockfilePath, "utf8"), await files(config)];
    const { code, text } = await init();
    expect(code).toBe(0);
    expect(text).toContain("✔ weather: already in latch.lock (0 tools); changes go through `latch review`");
    expect(text).toContain("nothing to change");
    expect(await readFile(config, "utf8")).toBe(configAfter);
    expect(await readFile(lockfilePath, "utf8")).toBe(lockAfter);
    expect(await files(config)).toEqual(filesAfter);
  });

  it("wraps a server configured in several clients and pins it once", async () => {
    const desktop = await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry } });
    const vscodeEntry = { type: "stdio", ...weatherEntry };
    const vscode = await writeConfig("vscode", { servers: { weather: vscodeEntry }, inputs: [] });
    const { code } = await init();
    expect(code).toBe(0);
    expect(Object.keys((await lockOnDisk()).servers)).toEqual(["weather"]);
    expect(JSON.parse(await readFile(desktop, "utf8")).mcpServers.weather).toEqual(expectedEntry(weatherEntry));
    expect(JSON.parse(await readFile(vscode, "utf8"))).toEqual({ servers: { weather: expectedEntry(vscodeEntry) }, inputs: [] });
  });

  it("only touches the client named with --client", async () => {
    const desktop = await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry } });
    const cursor = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const cursorBefore = await readFile(cursor, "utf8");
    await init({ client: "claude-desktop" });
    expect(JSON.parse(await readFile(desktop, "utf8")).mcpServers.weather).toEqual(expectedEntry(weatherEntry));
    expect(await readFile(cursor, "utf8")).toBe(cursorBefore);
  });

  it("wraps a new client's entry for a server latch.lock already pins, without re-pinning it", async () => {
    await writeConfig("claude-desktop", { mcpServers: { weather: weatherEntry } });
    await init();
    const lockBefore = await readFile(lockfilePath, "utf8");
    const cursor = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const { code } = await init();
    expect(code).toBe(0);
    expect(await readFile(lockfilePath, "utf8")).toBe(lockBefore);
    expect(JSON.parse(await readFile(cursor, "utf8")).mcpServers.weather).toEqual(expectedEntry(weatherEntry));
  });

  it("never starts a server or reads its env: it links even one that is not installed", async () => {
    // A command that does not exist: had init started it, it would have failed.
    const absent = { command: "latch-no-such-binary-for-test", args: ["--token", "x"], env: { API_KEY: "sk-secret" } };
    const config = await writeConfig("cursor", { mcpServers: { absent } });
    const { code, text } = await init();
    expect(code).toBe(0);
    expect(text).not.toContain("sk-secret");
    expect(JSON.parse(await readFile(config, "utf8")).mcpServers.absent).toEqual(expectedEntry(absent, "absent"));
    expect(await readFile(lockfilePath, "utf8")).not.toContain("sk-secret");
    expect((await lockOnDisk()).servers.absent).toEqual({ transport: "stdio", command: absent.command, args: absent.args, tools: [], trustOnFirstUse: true });
  });

  it("leaves a server alone when latch.lock launches it differently", async () => {
    const lock = example();
    lock.servers.weather!.command = "something-else";
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeFile(lockfilePath, JSON.stringify(lock));
    const config = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const before = await readFile(config, "utf8");
    const { code, text } = await init();
    expect(code).toBe(1);
    expect(text).toMatch(/✖ weather: latch\.lock launches it as something-else tsx demo\/weather-server\.ts, but the client runs .*; left unchanged/);
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("stops before changing anything when latch.lock is malformed", async () => {
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeFile(lockfilePath, "{ nope");
    const config = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const before = await readFile(config, "utf8");
    await expect(init()).rejects.toBeInstanceOf(LockfileError);
    expect(await readFile(config, "utf8")).toBe(before);
    expect(await files(config)).toEqual(["mcp.json"]);
  });

  it("exits 1 and lists where it looked when no client config exists", async () => {
    const { code, text } = await init();
    expect(code).toBe(1);
    expect(text).toContain("✖ no usable MCP client config found. Looked in:");
    expect(text).toContain(`  cursor: ${clientConfigPath("cursor")}`);
    const one = await init({ client: "vscode" });
    expect(one.text).toContain("✖ no usable MCP client config found for vscode. Looked in:");
    expect(one.text).not.toContain("cursor:");
  });

  it("warns about a config it cannot read, leaves it alone and exits 1", async () => {
    await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const broken = clientConfigPath("vscode");
    await mkdir(dirname(broken), { recursive: true });
    await writeFile(broken, '{ "servers": { "x": ');
    const { code, text } = await init({ dryRun: true });
    expect(code).toBe(1);
    expect(text).toContain(`! vscode: ${broken} is not valid JSON: ValueExpected at line 1, column 21; LatchVerify leaves it unchanged`);
    expect(text).toContain("would link");
    expect(await readFile(broken, "utf8")).toBe('{ "servers": { "x": ');
  });

  it("reports configs without stdio servers and conflicting ids", async () => {
    await writeConfig("claude-desktop", { mcpServers: { remote: { type: "http", url: "https://mcp.example" } } });
    expect((await init({ client: "claude-desktop" })).text).toContain("nothing to wrap: the configs have no stdio servers");
    await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    await writeConfig("vscode", { servers: { weather: { command: "other" } } });
    const conflict = await init();
    expect(conflict.code).toBe(1);
    expect(conflict.text).toContain("! skipping weather (cursor, vscode): cursor and vscode launch it with different commands");
  });

  it("keeps a server another writer added to latch.lock while init was linking", async () => {
    // Regression: init wrote back the lockfile it read at the start, so a pin or approval made
    // meanwhile was lost. "other" is added to latch.lock the moment init reports its link,
    // between its read and its write.
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeFile(lockfilePath, `${JSON.stringify(emptyLockfile(), null, 2)}\n`);
    await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    const output = new PassThrough();
    output.setEncoding("utf8").on("data", (chunk: string) => {
      if (!chunk.includes("weather: linked")) return;
      const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
      lock.servers.other = { transport: "stdio", command: "uvx", args: ["mcp-server-other"], tools: [] };
      writeFileSync(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`);
    });
    expect(await runInit({ dryRun: false, lockfilePath, output })).toBe(0);
    expect(Object.keys((await lockOnDisk()).servers).sort()).toEqual(["other", "weather"]);
  });

  it("launches the proxy by absolute path, so a client without latch on its PATH can start it", async () => {
    // Regression: init wrote command "latch", which Claude Desktop could not spawn.
    const config = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    expect((await init()).code).toBe(0);
    const entry = JSON.parse(await readFile(config, "utf8")).mcpServers.weather as ClientServerEntry;
    expect(entry.command).toBe(process.execPath);
    const launch = INSTALL_LAUNCH.args.length;
    expect(entry.args!.slice(0, launch)).toEqual(INSTALL_LAUNCH.args);
    expect(entry.args!.slice(launch, launch + 8)).toEqual(["--lockfile", lockfilePath, "--state-dir", join(home, "repo", ".latch"), "proxy", "--server", "weather", "--"]);
  });

  it("writes the launch it is given", async () => {
    const config = await writeConfig("cursor", { mcpServers: { weather: weatherEntry } });
    await init({ launch: { command: "latch", args: [] } });
    expect(JSON.parse(await readFile(config, "utf8")).mcpServers.weather.command).toBe("latch");
  });

  it("does not wrap an entry that already runs <node> <path>/cli.js proxy a second time", async () => {
    // Regression: weather, wrapped by hand this way, came out wrapped twice.
    const otherInstall = join(home, "opt", "latch", "dist", "cli.js");
    await mkdir(dirname(otherInstall), { recursive: true });
    await writeFile(otherInstall, "");
    const byHand = { ...wrapWithProxy("weather", weatherEntry, { command: process.execPath, args: [otherInstall] }) };
    const config = await writeConfig("cursor", { mcpServers: { weather: byHand } });
    expect((await init()).code).toBe(0);
    expect(Object.keys((await lockOnDisk()).servers)).toEqual(["weather"]);
    const entry = JSON.parse(await readFile(config, "utf8")).mcpServers.weather as ClientServerEntry;
    // Its own launch (another install that exists) is kept; only the lockfile and state directory are added.
    expect(entry).toEqual(wrapWithProxy("weather", weatherEntry, { command: process.execPath, args: [otherInstall] }, paths()));
  });

  it("moves an entry of this install to the current launch, and repairs one whose install is gone", async () => {
    // Written by an older version: the paths in env, no node flags.
    const env = { LATCH_LOCKFILE_PATH: lockfilePath, LATCH_STATE_DIR: join(home, "repo", ".latch") };
    const flagless = { ...wrapWithProxy("weather", weatherEntry, { command: INSTALL_LAUNCH.command, args: [INSTALL_LAUNCH.args.at(-1)!] }), env };
    const gone = { ...wrapWithProxy("forecast", weatherEntry, { command: "/opt/removed/node", args: ["/opt/removed/cli.js"] }), env };
    const config = await writeConfig("cursor", { mcpServers: { weather: flagless, forecast: gone } });
    expect((await init()).code).toBe(0);
    const servers = JSON.parse(await readFile(config, "utf8")).mcpServers as Record<string, ClientServerEntry>;
    expect(servers.weather).toEqual(expectedEntry(weatherEntry));
    expect(servers.forecast).toEqual(expectedEntry(weatherEntry, "forecast"));
  });
});

// These start two demo servers through tsx, which takes seconds when the whole suite runs at once.
describe.skipIf(process.platform === "win32")("runInit prompt", { timeout: 30_000 }, () => {
  let home: string;
  let lockfilePath: string;
  const weatherEntry = { command: process.execPath, args: ["--import", tsx, join(root, "demo/weather-server.ts")] };
  const alsoWeather = { ...weatherEntry, env: { SECOND: "1" } };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-init-prompt-"));
    lockfilePath = join(home, "latch.lock");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = clientConfigPath("cursor");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { alpha: weatherEntry, beta: alsoWeather } }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  /** Run init interactively, typing `keys` once the prompt is up. */
  async function initWith(keys: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (keys !== "" && text.includes("Which servers should latch protect?")) {
        // After the render returns: the prompt starts listening only once it has drawn itself.
        const typed = keys;
        setImmediate(() => input.write(typed));
        keys = "";
      }
    });
    const code = await runInit({ dryRun: false, lockfilePath, output, input, interactive: true });
    return { code, text: text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") };
  }

  const wrapped = async () =>
    Object.entries(JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers as Record<string, ClientServerEntry>)
      .filter(([, entry]) => entry.args?.includes("proxy"))
      .map(([id]) => id);

  it("offers every server, pre-selected, and takes them all on enter", async () => {
    const { code, text } = await initWith("\r");
    expect(code).toBe(0);
    expect(text).toContain("alpha");
    expect(text).toContain("cursor: ");
    expect(await wrapped()).toEqual(["alpha", "beta"]);
  });

  it("wraps and pins only the servers left selected", async () => {
    const { code } = await initWith(" \r");
    expect(code).toBe(0);
    expect(await wrapped()).toEqual(["beta"]);
    expect(Object.keys(LockFileSchema.parse(JSON.parse(await readFile(lockfilePath, "utf8"))).servers)).toEqual(["beta"]);
  });

  it("changes nothing when every server is deselected", async () => {
    const { code, text } = await initWith(" \x1b[B \r");
    expect(code).toBe(0);
    expect(text).toContain("no server chosen; nothing changed");
    expect(await wrapped()).toEqual([]);
    await expect(readFile(lockfilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("changes nothing and exits 1 when the prompt is cancelled", async () => {
    const { code, text } = await initWith("\x03");
    expect(code).toBe(1);
    expect(text).toContain("cancelled; nothing changed");
    expect(await wrapped()).toEqual([]);
    await expect(readFile(lockfilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
