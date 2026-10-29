import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnv, runAdd, type AddOptions } from "../../src/commands/add.js";
import { INSTALL_LAUNCH, clientConfigPath, type ClientServerEntry } from "../../src/config/clients.js";
import { LockFileSchema } from "../../src/schema/index.js";
import { LockfileError } from "../../src/store/lockfile.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Absolute, so children started outside the repo still find tsx.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const weather = [process.execPath, "--import", tsx, join(root, "demo/weather-server.ts")];
const evil = [process.execPath, "--import", tsx, join(root, "demo/evil-server.ts")];

describe("parseEnv", () => {
  it("sets KEY=VALUE and copies a bare KEY from the source environment", () => {
    expect(parseEnv(["A=1", "TOKEN", "EMPTY=", "URL=a=b"], { TOKEN: "secret" })).toEqual({ A: "1", TOKEN: "secret", EMPTY: "", URL: "a=b" });
  });

  it("rejects a bare KEY that is not set, and invalid names", () => {
    expect(() => parseEnv(["TOKEN"], {})).toThrow("--env TOKEN: TOKEN is not set in this shell");
    expect(() => parseEnv(["=1"], {})).toThrow("expected KEY or KEY=VALUE");
    expect(() => parseEnv(["A B=1"], {})).toThrow("expected KEY or KEY=VALUE");
  });

  it("keeps a variable named __proto__ as plain data", () => {
    const env = parseEnv(["__proto__=x"], {});
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.hasOwn(env, "__proto__")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("runAdd", () => {
  let home: string;
  let lockfilePath: string;
  let configPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-add-"));
    lockfilePath = join(home, "repo", "latch.lock");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    configPath = clientConfigPath("claude-desktop");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    await mkdir(dirname(configPath), { recursive: true });
    const text = JSON.stringify(contents, null, 2);
    await writeFile(configPath, text);
    return text;
  }

  /** Run add and return its exit code and output, without ANSI colours. */
  async function add(options: Partial<AddOptions> = {}) {
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    const code = await runAdd({
      name: "weather",
      command: weather,
      client: "claude-desktop",
      env: [],
      dryRun: false,
      lockfilePath,
      reviewer: "dev@example.com",
      timeoutMs: 20_000,
      output,
      sourceEnv: {},
      ...options,
    });
    return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  const configOnDisk = async () => JSON.parse(await readFile(configPath, "utf8"));
  const lockOnDisk = async () => LockFileSchema.parse(JSON.parse(await readFile(lockfilePath, "utf8")));
  const stateDir = () => join(home, "repo", ".latch");
  const exists = async (path: string) => (await readdir(dirname(path)).catch((): string[] => [])).includes(path.split("/").pop()!);

  it("pins one server and adds it wrapped by absolute path, leaving the rest of the config alone", async () => {
    const other: ClientServerEntry = { command: "node", args: ["other.js"], env: { KEY: "keep" } };
    const before = await writeConfig({ mcpServers: { other }, preferences: { x: 1 } });
    const { code, text } = await add();
    expect(code).toBe(0);
    expect(text).toContain("✔ weather: pinned 2 tools: get_forecast, get_alerts");
    expect(text).toContain("(the original is kept as a .bak copy)");
    expect(text).toContain("next: restart claude-desktop");

    expect(await configOnDisk()).toEqual({
      mcpServers: {
        other,
        weather: {
          command: INSTALL_LAUNCH.command,
          args: [...INSTALL_LAUNCH.args, "proxy", "--server", "weather", "--", ...weather],
          env: { LATCH_LOCKFILE_PATH: lockfilePath, LATCH_STATE_DIR: stateDir() },
        },
      },
      preferences: { x: 1 },
    });
    const backup = (await readdir(dirname(configPath))).find((file) => file.endsWith(".bak"))!;
    expect(await readFile(join(dirname(configPath), backup), "utf8")).toBe(before);

    const lock = await lockOnDisk();
    expect(Object.keys(lock.servers)).toEqual(["weather"]);
    expect(lock.servers.weather).toMatchObject({ transport: "stdio", command: weather[0], args: weather.slice(1) });
    expect(lock.servers.weather!.tools.map((t) => t.approvedBy)).toEqual(["dev@example.com", "dev@example.com"]);
  });

  it("creates the client config when there is none", async () => {
    const { code, text } = await add();
    expect(code).toBe(0);
    expect(text).not.toContain(".bak");
    expect(Object.keys((await configOnDisk()).mcpServers)).toEqual(["weather"]);
  });

  it("writes --env values into the entry without printing them", async () => {
    await writeConfig({ mcpServers: {} });
    const { code, text } = await add({ env: ["TOKEN", "MODE=demo"], sourceEnv: { TOKEN: "s3cret-token" } });
    expect(code).toBe(0);
    expect(text).not.toContain("s3cret-token");
    expect((await configOnDisk()).mcpServers.weather.env).toEqual({
      TOKEN: "s3cret-token",
      MODE: "demo",
      LATCH_LOCKFILE_PATH: lockfilePath,
      LATCH_STATE_DIR: stateDir(),
    });
  });

  it("refuses a name the client config already has, even for an HTTP server, and writes nothing", async () => {
    const before = await writeConfig({ mcpServers: { weather: { type: "http", url: "https://mcp.example" } } });
    const { code, text } = await add();
    expect(code).toBe(1);
    expect(text).toContain(`✖ weather is already in ${configPath}`);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await exists(lockfilePath)).toBe(false);
  });

  it("refuses to add to a client config that does not parse, before starting the server", async () => {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ broken");
    const { code, text } = await add();
    expect(code).toBe(1);
    expect(text).toContain(`✖ ${configPath} is not valid JSON`);
    expect(text).not.toContain("starting");
    expect(await readFile(configPath, "utf8")).toBe("{ broken");
    expect(await exists(lockfilePath)).toBe(false);
  });

  it("refuses a name latch.lock already pins, and writes nothing", async () => {
    await writeConfig({ mcpServers: {} });
    expect((await add({ name: "first" })).code).toBe(0);
    const [config, lock] = [await readFile(configPath, "utf8"), await readFile(lockfilePath, "utf8")];
    await writeConfig({ mcpServers: {} });
    const { code, text } = await add({ name: "first" });
    expect(code).toBe(1);
    expect(text).toContain("✖ first is already in latch.lock; changes to a pinned server go through `latch review`");
    expect(await readFile(lockfilePath, "utf8")).toBe(lock);
    expect(config).toContain('"first"');
  });

  it("writes nothing when the server's tools cannot be captured", async () => {
    const before = await writeConfig({ mcpServers: {} });
    const { code, text } = await add({ name: "broken", command: ["latch-no-such-binary-for-test"] });
    expect(code).toBe(1);
    expect(text).toContain("✖ broken: could not start latch-no-such-binary-for-test");
    expect(text).toContain("nothing written");
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await exists(lockfilePath)).toBe(false);
  });

  it("refuses a bad name or a missing --env variable before starting anything", async () => {
    expect((await add({ name: "--evil" })).text).toContain('must be non-empty and not start with "-"');
    const missing = await add({ env: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("GITHUB_PERSONAL_ACCESS_TOKEN is not set in this shell");
    expect(missing.text).not.toContain("starting");
    expect(await exists(configPath)).toBe(false);
  });

  it("dry run reports what it would do and writes nothing", async () => {
    const before = await writeConfig({ mcpServers: {} });
    const { code, text } = await add({ dryRun: true });
    expect(code).toBe(0);
    expect(text).toContain("✔ weather: would pin 2 tools");
    expect(text).toContain(`would write ${lockfilePath} and add weather to ${configPath}:`);
    expect(text).toContain(`${INSTALL_LAUNCH.command} ${INSTALL_LAUNCH.args[0]} proxy --server weather -- `);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await exists(lockfilePath)).toBe(false);
  });

  it("holds back poisoned tools but still adds the server, so the proxy queues them for review", async () => {
    const { code, text } = await add({ command: evil, env: ["DEMO_MUTATE=1"] });
    expect(code).toBe(0);
    expect(text).toContain("✔ weather: pinned 1 tool: read_config");
    expect(text).toMatch(/! get_forecast held back for `latch review`: Critical pattern finding/);
    expect((await lockOnDisk()).servers.weather!.tools.map((t) => t.name)).toEqual(["read_config"]);
    expect((await configOnDisk()).mcpServers.weather.args).toContain("proxy");
  });

  it("stops before changing anything when latch.lock is malformed", async () => {
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeFile(lockfilePath, "{ nope");
    const before = await writeConfig({ mcpServers: {} });
    await expect(add()).rejects.toBeInstanceOf(LockfileError);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });
});
