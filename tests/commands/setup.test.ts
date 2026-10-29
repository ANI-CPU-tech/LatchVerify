import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup, runUnlink, type SetupOptions } from "../../src/commands/setup.js";
import { INSTALL_LAUNCH, clientConfigPath, wrapWithProxy } from "../../src/config/clients.js";
import { LockFileSchema } from "../../src/schema/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const weather = { command: process.execPath, args: ["--import", tsx, join(root, "demo/weather-server.ts")] };

describe.skipIf(process.platform === "win32")("runSetup", () => {
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
    const code = await runSetup({ client: "claude-code", dryRun: false, lockfilePath, reviewer: "dev@example.com", timeoutMs: 20_000, output, ...options });
    return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  async function claudeConfig(contents: unknown): Promise<string> {
    const path = clientConfigPath("claude-code");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(contents, null, 2));
    return path;
  }

  const lockOnDisk = async () => LockFileSchema.parse(JSON.parse(await readFile(lockfilePath, "utf8")));

  it("links Claude Code: pins its servers into the per-user lockfile and wraps them, without asking", async () => {
    const config = await claudeConfig({ mcpServers: { weather }, numStartups: 3 });
    const { code, text } = await setup();
    expect(code).toBe(0);
    expect(text).toContain(`latch setup: linking Claude Code to ${lockfilePath}`);
    expect(text).toContain("✔ weather: pinned 2 tools");
    expect(text).toContain("next: restart Claude Code");
    expect(text).not.toContain("next: commit");

    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: {
        weather: { ...wrapWithProxy("weather", weather, INSTALL_LAUNCH), env: { LATCH_LOCKFILE_PATH: lockfilePath, LATCH_STATE_DIR: join(dirname(lockfilePath), ".latch") } },
      },
      numStartups: 3,
    });
    expect((await lockOnDisk()).servers.weather!.tools.map((tool) => tool.name)).toEqual(["get_alerts", "get_forecast"]);
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

  it("writes nothing on a dry run", async () => {
    const config = await claudeConfig({ mcpServers: { weather } });
    const before = await readFile(config, "utf8");
    const { code, text } = await setup({ dryRun: true });
    expect(code).toBe(0);
    expect(text).toContain("would pin 2 tools");
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
