import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_LAUNCH, clientConfigPath, unwrapProxy, wrapWithProxy, type ClientId, type ClientServerEntry } from "../../src/config/clients.js";
import { syncClients, type SyncOptions } from "../../src/daemon/sync.js";
import { DEFAULT_SETTINGS, LockFileSchema } from "../../src/schema/index.js";
import { emptyLockfile, writeLockfile } from "../../src/store/lockfile.js";

const tools = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/benign-tools.json", import.meta.url)), "utf8")).tools;

/** A stdio server listing the benign fixture's tools, quick to start (no tsx). */
const stub = (tag: string): ClientServerEntry => ({
  command: process.execPath,
  args: [
    "-e",
    `// ${tag}
const tools = ${JSON.stringify(tools)};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
  ],
});

describe.skipIf(process.platform === "win32")("syncClients", { timeout: 30_000 }, () => {
  let home: string;
  let options: SyncOptions;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-sync-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    options = { lockfilePath, stateDir: join(dirname(lockfilePath), ".latch"), settings: DEFAULT_SETTINGS };
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(client: ClientId, contents: unknown): Promise<string> {
    const path = clientConfigPath(client);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
    return path;
  }
  const servers = async (path: string, key = "mcpServers") => JSON.parse(await readFile(path, "utf8"))[key] as Record<string, ClientServerEntry>;
  const lockOnDisk = async () => LockFileSchema.parse(JSON.parse(await readFile(options.lockfilePath, "utf8")));

  it("links a new server to be pinned on its first run and wraps it, then has nothing to do", async () => {
    const path = await writeConfig("cursor", { mcpServers: { weather: stub("w") } });
    const first = await syncClients(options);
    expect(first.linked).toEqual(["weather"]);
    expect(first.wrapped).toEqual([{ client: "cursor", path, serverIds: ["weather"] }]);
    expect(first.failed).toEqual([]);
    const entry = (await servers(path)).weather!;
    expect(entry.args!.slice(0, INSTALL_LAUNCH.args.length)).toEqual(INSTALL_LAUNCH.args);
    expect(entry).toEqual(wrapWithProxy("weather", stub("w"), INSTALL_LAUNCH, { lockfilePath: options.lockfilePath, stateDir: options.stateDir }));
    expect((await lockOnDisk()).servers.weather).toEqual({ transport: "stdio", command: stub("w").command, args: stub("w").args, tools: [], trustOnFirstUse: true });

    const before = await readFile(path, "utf8");
    const second = await syncClients(options);
    expect(second).toEqual({ problems: [], skipped: [], linked: [], failed: [], wrapped: [] });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("leaves a client the user turned off alone", async () => {
    const path = await writeConfig("cursor", { mcpServers: { weather: stub("w") } });
    const before = await readFile(path, "utf8");
    const result = await syncClients({ ...options, settings: { ...DEFAULT_SETTINGS, clients: { cursor: false } } });
    expect(result).toEqual({ problems: [], skipped: [], linked: [], failed: [], wrapped: [] });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("re-wraps an entry the client turned back into the original, without linking again", async () => {
    const path = await writeConfig("cursor", { mcpServers: { weather: stub("w") } });
    await syncClients(options);
    const lockBefore = await readFile(options.lockfilePath, "utf8");
    await writeConfig("cursor", { mcpServers: { weather: stub("w") } });
    const result = await syncClients(options);
    expect(result.linked).toEqual([]);
    expect(result.wrapped).toEqual([{ client: "cursor", path, serverIds: ["weather"] }]);
    expect(unwrapProxy((await servers(path)).weather!)).toEqual(stub("w"));
    expect(await readFile(options.lockfilePath, "utf8")).toBe(lockBefore);
  });

  it("repairs an entry that starts latch from an old location", async () => {
    const old = { ...wrapWithProxy("weather", stub("w"), { command: "/opt/gone/node", args: ["/opt/gone/cli.js"] }), env: { LATCH_LOCKFILE_PATH: options.lockfilePath, LATCH_STATE_DIR: options.stateDir } };
    const path = await writeConfig("cursor", { mcpServers: { weather: old } });
    const result = await syncClients(options);
    expect(result.wrapped).toEqual([{ client: "cursor", path, serverIds: ["weather"] }]);
    expect((await servers(path)).weather!.command).toBe(INSTALL_LAUNCH.command);
  });

  it("does not wrap a server latch.lock launches differently, and says so", async () => {
    const path = await writeConfig("cursor", { mcpServers: { weather: stub("w") } });
    await syncClients(options);
    await writeConfig("cursor", { mcpServers: { weather: stub("changed command") } });
    const result = await syncClients(options);
    expect(result.failed).toEqual([{ serverId: "weather", reason: "latch.lock launches it with another command than the client does; left unwrapped" }]);
    expect(result.wrapped).toEqual([]);
    expect((await servers(path)).weather).toEqual(stub("changed command"));
  });

  it("reports a config it cannot read and links the rest, without starting any server", async () => {
    await writeConfig("vscode", "{ broken");
    // Not installed: the sync links it all the same, since it never starts servers.
    const path = await writeConfig("cursor", { mcpServers: { absent: { command: "latch-no-such-binary-for-test", env: { KEY: "sk-secret" } }, weather: stub("w") } });
    const result = await syncClients(options);
    expect(result.problems.map((problem) => problem.client)).toEqual(["vscode"]);
    expect(result.failed).toEqual([]);
    expect(result.wrapped).toEqual([{ client: "cursor", path, serverIds: ["absent", "weather"] }]);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.absent.env).toEqual({ KEY: "sk-secret" });
    expect(await readFile(options.lockfilePath, "utf8")).not.toContain("sk-secret");
  });
});
