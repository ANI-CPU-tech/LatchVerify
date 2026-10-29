import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchHash, programName } from "../../src/analyze/hash.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup, runUnlink, type SetupOptions } from "../../src/commands/setup.js";
import { INSTALL_LAUNCH, clientConfigPath, clientLocations, wrapWithProxy, type ClientId } from "../../src/config/clients.js";
import { LockFileSchema } from "../../src/schema/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const weather = { command: process.execPath, args: ["--import", tsx, join(root, "demo/weather-server.ts")] };

// Every test here starts demo servers through tsx, which takes seconds when the whole suite runs at once.
describe.skipIf(process.platform === "win32")("runSetup", { timeout: 30_000 }, () => {
  let home: string;
  let lockfilePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-setup-"));
    lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function setup(options: Partial<SetupOptions> = {}) {
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    const code = await runSetup({ client: "claude-code", dryRun: false, lockfilePath, output, ...options });
    return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  async function claudeConfig(contents: unknown): Promise<string> {
    const path = clientConfigPath("claude-code");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(contents, null, 2));
    return path;
  }

  const lockOnDisk = async () => LockFileSchema.parse(JSON.parse(await readFile(lockfilePath, "utf8")));

  it("links Claude Code: adds its servers to the per-user lockfile and wraps them, without asking", async () => {
    const config = await claudeConfig({ mcpServers: { weather }, numStartups: 3 });
    const { code, text } = await setup();
    expect(code).toBe(0);
    expect(text).toContain(`latch setup: linking Claude Code to ${lockfilePath}`);
    expect(text).toContain("✔ weather: linked; its tools are pinned the first time claude-code starts it");
    expect(text).toContain("next: restart Claude Code");
    expect(text).not.toContain("next: commit");

    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: {
        weather: wrapWithProxy("weather", weather, INSTALL_LAUNCH, { lockfilePath, stateDir: join(dirname(lockfilePath), ".latch") }),
      },
      numStartups: 3,
    });
    expect((await lockOnDisk()).servers.weather).toEqual({ transport: "stdio", program: programName(weather.command), launch: launchHash(weather.command, weather.args), tools: [], trustOnFirstUse: true });
  });

  it("changes nothing when run again", async () => {
    const config = await claudeConfig({ mcpServers: { weather } });
    expect((await setup()).code).toBe(0);
    const [configAfter, lockAfter] = [await readFile(config, "utf8"), await readFile(lockfilePath, "utf8")];
    const again = await setup();
    expect(again.code).toBe(0);
    expect(again.text).toContain("already in latch.lock");
    expect(await readFile(config, "utf8")).toBe(configAfter);
    expect(await readFile(lockfilePath, "utf8")).toBe(lockAfter);
  });

  it("still creates the lockfile, and succeeds, when Claude Code is not installed yet", async () => {
    const { code, text } = await setup();
    expect(code).toBe(0);
    expect(text).toContain("Claude Code is not set up on this machine yet");
    expect(text).toContain("run `latch setup` again");
    expect(text).toContain(`✔ created ${lockfilePath}`);
    expect(await lockOnDisk()).toMatchObject({ servers: {} });
  });

  it("creates an empty lockfile when Claude Code has no MCP servers", async () => {
    await claudeConfig({ mcpServers: {} });
    expect((await setup()).code).toBe(0);
    expect((await lockOnDisk()).servers).toEqual({});
  });

  describe("--all", () => {
    /** Writes `contents` as `client`'s main config. */
    async function clientConfig(client: ClientId, contents: unknown): Promise<string> {
      const path = clientConfigPath(client);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
      return path;
    }

    it("links every client it finds, then --remove --all unlinks every one", async () => {
      const claude = await claudeConfig({ mcpServers: { weather } });
      const zed = await clientConfig("zed", `// my settings\n{\n  "theme": "One Dark",\n  "context_servers": {\n    "forecast": ${JSON.stringify(weather)}\n  }\n}\n`);
      const zedBefore = await readFile(zed, "utf8");

      const { code, text } = await setup({ client: undefined });
      expect(code).toBe(0);
      expect(text).toContain(`latch setup: linking every MCP client found to ${lockfilePath}`);
      expect(text).toContain("next: restart Claude Code and Zed so their MCP servers start behind latch");
      expect(JSON.parse(await readFile(claude, "utf8")).mcpServers.weather.args).toContain("proxy");
      const zedLinked = await readFile(zed, "utf8");
      expect(zedLinked.startsWith('// my settings\n{\n  "theme": "One Dark",')).toBe(true);
      expect(zedLinked).toContain('"proxy"');

      const output = new PassThrough();
      let unlinked = "";
      output.setEncoding("utf8").on("data", (chunk: string) => (unlinked += chunk));
      expect(await runUnlink({ client: undefined, dryRun: false, output })).toBe(0);
      expect(unlinked).toContain("latch setup --remove: unlinking every MCP client");
      expect(unlinked).toContain("next: restart Claude Code and Zed.");
      expect(JSON.parse(await readFile(claude, "utf8"))).toEqual({ mcpServers: { weather } });
      const zedRestored = await readFile(zed, "utf8");
      expect(zedRestored.startsWith("// my settings\n")).toBe(true);
      expect(JSON.parse(zedRestored.replace("// my settings\n", ""))).toEqual(JSON.parse(zedBefore.replace("// my settings\n", "")));
    });

    it("succeeds with a note when no client is set up, and still creates the lockfile", async () => {
      const { code, text } = await setup({ client: undefined });
      expect(code).toBe(0);
      expect(text).toContain("! no MCP client is set up on this machine yet.");
      expect(text).toContain("run `latch setup --all` again");
      await lockOnDisk();
      const output = new PassThrough();
      let unlinked = "";
      output.setEncoding("utf8").on("data", (chunk: string) => (unlinked += chunk));
      expect(await runUnlink({ client: undefined, dryRun: false, output })).toBe(0);
      expect(unlinked).toContain("nothing to unlink: no MCP client is set up on this machine");
    });

    it("links the clients it can read and exits 1 over one it cannot", async () => {
      const claude = await claudeConfig({ mcpServers: { weather } });
      const broken = await clientConfig("cursor", "{ broken");
      const { code, text } = await setup({ client: undefined });
      expect(code).toBe(1);
      expect(text).toContain(`! cursor: ${broken} is not valid JSON`);
      expect(JSON.parse(await readFile(claude, "utf8")).mcpServers.weather.args).toContain("proxy");
      // Claude Code was linked all the same, so it must be restarted.
      expect(text).toContain("next: restart Claude Code so its MCP servers start behind latch");
      expect(await readFile(broken, "utf8")).toBe("{ broken");
    });
  });

  it("links and unlinks Claude Code's per-project servers too", async () => {
    const original = { mcpServers: { weather }, projects: { "/srv/app": { mcpServers: { forecast: weather }, allowedTools: [] } } };
    const config = await claudeConfig(original);
    const linked = await setup();
    expect(linked.code).toBe(0);
    expect(linked.text).toContain(`found claude-code: ${config} (project /srv/app) (1 stdio server)`);
    expect(linked.text).toContain(`wrapped 1 server in ${config} (project /srv/app)`);
    const after = JSON.parse(await readFile(config, "utf8"));
    expect(after.mcpServers.weather.args).toContain("proxy");
    expect(after.projects["/srv/app"].mcpServers.forecast.args).toContain("proxy");
    expect(after.projects["/srv/app"].allowedTools).toEqual([]);
    expect(Object.keys((await lockOnDisk()).servers).sort()).toEqual(["forecast", "weather"]);

    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    expect(await runUnlink({ client: "claude-code", dryRun: false, output })).toBe(0);
    expect(text).toContain(`restored 1 server in ${config} (project /srv/app)`);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(original);
  });

  it("links and unlinks every file of a client that keeps servers in two (Amazon Q)", async () => {
    const [legacy, agent] = clientLocations("amazon-q").map((location) => location.path);
    await mkdir(dirname(legacy!), { recursive: true });
    await writeFile(legacy!, JSON.stringify({ mcpServers: { weather } }, null, 2));
    const agentConfig = { name: "default", mcpServers: { forecast: weather }, tools: ["*"] };
    await writeFile(agent!, JSON.stringify(agentConfig, null, 2));

    const linked = await setup({ client: "amazon-q" });
    expect(linked.code).toBe(0);
    expect(linked.text).toContain(`latch setup: linking Amazon Q Developer to ${lockfilePath}`);
    expect(linked.text).toContain(`wrapped 1 server in ${legacy}`);
    expect(linked.text).toContain(`wrapped 1 server in ${agent}`);
    expect(JSON.parse(await readFile(legacy!, "utf8")).mcpServers.weather.args).toContain("proxy");
    const wrappedAgent = JSON.parse(await readFile(agent!, "utf8"));
    expect(wrappedAgent.mcpServers.forecast.args).toContain("proxy");
    expect(wrappedAgent.tools).toEqual(["*"]);

    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    expect(await runUnlink({ client: "amazon-q", dryRun: false, output })).toBe(0);
    expect(text).toContain(`restored 1 server in ${legacy}`);
    expect(text).toContain(`restored 1 server in ${agent}`);
    expect(JSON.parse(await readFile(legacy!, "utf8"))).toEqual({ mcpServers: { weather } });
    expect(JSON.parse(await readFile(agent!, "utf8"))).toEqual(agentConfig);
  });

  it("exits 1 and leaves Claude Code's config alone when it does not parse", async () => {
    const path = clientConfigPath("claude-code");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ broken");
    const { code, text } = await setup();
    expect(code).toBe(1);
    expect(text).toContain(`! claude-code: ${path} is not valid JSON`);
    expect(text).toContain("Fix the file, or let Claude Code rewrite it, then run `latch setup` again.");
    expect(await readFile(path, "utf8")).toBe("{ broken");
    // The per-user lockfile is still created, so review and verify find it.
    await lockOnDisk();
    expect((await runUnlink({ client: "claude-code", dryRun: false, output: new PassThrough() }))).toBe(1);
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });

  it("tells the user to delete the backups earlier versions left, without reading or deleting them", async () => {
    const config = await claudeConfig({ mcpServers: { weather } });
    const old = `${config}.2026-10-23T09-00-00-000Z.bak`;
    await writeFile(old, '{"mcpServers":{"weather":{"env":{"API_KEY":"sk-CANARY-backup"}}}}');
    const { text } = await setup();
    expect(text).toContain("! 1 copy of your client configs, made by an earlier LatchVerify version, still holds your API keys. LatchVerify no longer makes them; delete it:");
    expect(text).toContain(`    ${old}`);
    expect(text).not.toContain("sk-CANARY-backup");
    expect(await readFile(old, "utf8")).toContain("sk-CANARY-backup");
  });

  it("writes nothing on a dry run", async () => {
    const config = await claudeConfig({ mcpServers: { weather } });
    const before = await readFile(config, "utf8");
    const { code, text } = await setup({ dryRun: true });
    expect(code).toBe(0);
    expect(text).toContain("would link");
    expect(await readFile(config, "utf8")).toBe(before);
    await expect(readFile(lockfilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("--remove", () => {
    async function unlink(dryRun = false) {
      const output = new PassThrough();
      let text = "";
      output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      const code = await runUnlink({ client: "claude-code", dryRun, output });
      return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
    }

    it("restores the original entries, keeps their own env and other servers, and keeps latch.lock", async () => {
      const keyed = { ...weather, env: { WEATHER_KEY: "abc" } };
      const plain = { command: "some-http-bridge", args: ["--port", "1"] };
      const original = { mcpServers: { weather: keyed }, numStartups: 3 };
      const config = await claudeConfig(original);
      expect((await setup()).code).toBe(0);
      // A server added after setup is not wrapped, and must come through unlink untouched.
      const linked = JSON.parse(await readFile(config, "utf8"));
      await writeFile(config, JSON.stringify({ ...linked, mcpServers: { ...linked.mcpServers, plain } }));
      const lockBefore = await readFile(lockfilePath, "utf8");

      const { code, text } = await unlink();
      expect(code).toBe(0);
      expect(text).toContain("✔ restored 1 server");
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ ...original, mcpServers: { weather: keyed, plain } });
      expect(await readFile(lockfilePath, "utf8")).toBe(lockBefore);
    });

    it("drops an env that only held latch's variables", async () => {
      const config = await claudeConfig({ mcpServers: { weather } });
      await setup();
      await unlink();
      expect(JSON.parse(await readFile(config, "utf8")).mcpServers.weather).toEqual(weather);
    });

    it("succeeds with nothing to do, and writes nothing on a dry run", async () => {
      expect((await unlink()).text).toContain("is not set up on this machine");
      const config = await claudeConfig({ mcpServers: { weather } });
      expect((await unlink()).text).toContain("no server in");
      await setup();
      const linked = await readFile(config, "utf8");
      const dry = await unlink(true);
      expect(dry.code).toBe(0);
      expect(dry.text).toContain("would restore 1 server");
      expect(await readFile(config, "utf8")).toBe(linked);
    });
  });
});
