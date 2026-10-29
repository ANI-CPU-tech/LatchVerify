import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientConfigPath, type ClientServerEntry } from "../../src/config/clients.js";
import type { DesktopNotification } from "../../src/daemon/notify.js";
import { AlreadyWatchingError, WATCH_PID_FILE, startWatcher, type WatchOptions, type Watcher } from "../../src/daemon/watch.js";
import { createLogger } from "../../src/log.js";
import { LockFileSchema, type PendingChange } from "../../src/schema/index.js";
import { emptyLockfile, writeLockfile } from "../../src/store/lockfile.js";
import { writePending } from "../../src/store/pending.js";
import { updateSettings } from "../../src/store/settings.js";

const tools = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/benign-tools.json", import.meta.url)), "utf8")).tools;
const example = LockFileSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../latch.lock.example", import.meta.url)), "utf8")));

const stub: ClientServerEntry = {
  command: process.execPath,
  args: [
    "-e",
    `const tools = ${JSON.stringify(tools)};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
  ],
};

const change = (id: string, tier: PendingChange["tier"]): PendingChange => {
  const record = example.servers.weather!.tools[0]!;
  return { id, serverId: "weather", toolName: record.name, tier, detectedAt: "2026-10-29T09:00:00.000Z", before: record, after: record, capabilityDelta: { gained: ["exec.enabled"], lost: [], loosened: [] }, findings: [] };
};

/** Resolves once `check` passes, polling every 25 ms for up to `ms`. */
async function eventually(check: () => void | Promise<void>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe.skipIf(process.platform === "win32")("startWatcher", { timeout: 30_000 }, () => {
  let home: string;
  let options: WatchOptions;
  let shown: DesktopNotification[];
  let watcher: Watcher | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-watch-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
    shown = [];
    options = {
      lockfilePath,
      stateDir: join(dirname(lockfilePath), ".latch"),
      settingsPath: join(dirname(lockfilePath), "settings.json"),
      
      log: createLogger("error", () => {}),
      notify: async (notification) => void shown.push(notification),
      debounceMs: 50,
      pollMs: 60_000,
      blockWindowMs: 300,
      
    };
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  const cursorServers = async () => JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers as Record<string, ClientServerEntry>;

  it("links a server added to a connected client's config while it runs", async () => {
    await updateSettings(options.settingsPath, { clients: { cursor: true } });
    await mkdir(dirname(clientConfigPath("cursor")), { recursive: true });
    watcher = await startWatcher(options);
    await writeFile(clientConfigPath("cursor"), JSON.stringify({ mcpServers: { weather: stub } }));
    await eventually(async () => expect((await cursorServers()).weather!.args).toContain("proxy"));
    expect(LockFileSchema.parse(JSON.parse(await readFile(options.lockfilePath, "utf8"))).servers.weather).toMatchObject({ tools: [], trustOnFirstUse: true });
  });

  it("announces a client it was never told to connect, once, and leaves it alone", async () => {
    const path = clientConfigPath("cursor");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { weather: stub } }));
    watcher = await startWatcher(options);
    expect(shown).toEqual([expect.objectContaining({ title: "Found Cursor with 1 MCP server" })]);
    await watcher.syncNow();
    expect(shown).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.weather).toEqual(stub);
  });

  it("says at start how many changes wait for review", async () => {
    await writePending(options.stateDir, [change("chg_1", 2), change("chg_2", 3)]);
    watcher = await startWatcher(options);
    expect(shown).toEqual([expect.objectContaining({ title: "2 tool changes wait for your review", urgency: "critical" })]);
  });

  it("shows a change a proxy queues while it runs, once", async () => {
    await writePending(options.stateDir, [change("chg_1", 2)]);
    watcher = await startWatcher(options);
    shown.length = 0;
    await writePending(options.stateDir, [change("chg_1", 2), change("chg_2", 2)]);
    await eventually(() => expect(shown).toEqual([expect.objectContaining({ title: "weather/get_alerts changed and needs review" })]));
  });

  it("shows a blocked call at once and sums up the repeats", async () => {
    await mkdir(options.stateDir, { recursive: true });
    await writeFile(join(options.stateDir, "events.jsonl"), `${JSON.stringify({ kind: "tools_listed", at: "2026-10-29T09:00:00.000Z", serverId: "weather", toolCount: 2 })}\n`);
    watcher = await startWatcher(options);
    const line = (reason: string) => `${JSON.stringify({ kind: "call_blocked", at: new Date().toISOString(), serverId: "weather", toolName: "get_forecast", reason })}\n`;
    await appendFile(join(options.stateDir, "events.jsonl"), line("pending_review chg_1"));
    await eventually(() => expect(shown).toHaveLength(1));
    await appendFile(join(options.stateDir, "events.jsonl"), line("pending_review chg_1") + line("pending_review chg_1"));
    await eventually(() => expect(shown.map((notification) => notification.title)).toEqual(["Blocked weather/get_forecast", "Blocked weather/get_forecast (2 calls)"]));
  });

  it("stays quiet when notifications are off", async () => {
    await updateSettings(options.settingsPath, { notifications: false });
    await writePending(options.stateDir, [change("chg_1", 3)]);
    watcher = await startWatcher(options);
    expect(shown).toEqual([]);
  });

  it("runs once per state directory, and frees it when closed", async () => {
    watcher = await startWatcher(options);
    await expect(startWatcher(options)).rejects.toThrow(AlreadyWatchingError);
    await watcher.close();
    watcher = undefined;
    await expect(readFile(join(options.stateDir, WATCH_PID_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    watcher = await startWatcher(options);
  });

  it("takes over from a watcher that died", async () => {
    await mkdir(options.stateDir, { recursive: true });
    await writeFile(join(options.stateDir, WATCH_PID_FILE), "999999999\n");
    watcher = await startWatcher(options);
    expect(await readFile(join(options.stateDir, WATCH_PID_FILE), "utf8")).toBe(`${process.pid}\n`);
  });
});
