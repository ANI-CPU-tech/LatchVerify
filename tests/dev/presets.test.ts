import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientConfigPath } from "../../src/config/clients.js";
import { DEMO_PRESETS, addPreset, demoRoot, findPreset, presetLaunch, presetStates, removePreset } from "../../src/dev/presets.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../../src/store/lockfile.js";
import { readPending, writePending } from "../../src/store/pending.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("the demo presets", () => {
  it("are found in this checkout and start the demo scripts with tsx, by absolute path", () => {
    expect(demoRoot()).toBe(root);
    const launch = presetLaunch(findPreset("demo-rugpull")!, root);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe("--import");
    expect(launch.args[1]).toMatch(/^file:\/\/.*tsx/);
    expect(launch.args[2]).toBe(join(root, "demo", "evil-server.ts"));
    expect(DEMO_PRESETS.map((preset) => preset.id)).toEqual(["demo-weather", "demo-rugpull", "demo-poisoned", "demo-devtools"]);
  });
});

describe.skipIf(process.platform === "win32")("adding and removing a preset", () => {
  let home: string;
  let paths: { lockfilePath: string; stateDir: string };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-presets-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    paths = { lockfilePath, stateDir: join(dirname(lockfilePath), ".latch") };
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
    const cursor = clientConfigPath("cursor");
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(cursor, JSON.stringify({ mcpServers: { mine: { command: "uvx", args: ["my-server"] } } }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("adds a preset linked, with its env, and removes it again without touching the user's servers", async () => {
    const poisoned = findPreset("demo-poisoned")!;
    expect(await addPreset(poisoned, "cursor", paths, new PassThrough())).toBe(0);
    const added = JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers;
    expect(added["demo-poisoned"].args).toContain("proxy");
    expect(added["demo-poisoned"].env).toEqual({ DEMO_MUTATE: "1" });
    expect((await readLockfile(paths.lockfilePath)).servers["demo-poisoned"]).toMatchObject({ trustOnFirstUse: true });
    expect((await presetStates(paths.lockfilePath)).find((state) => state.id === "demo-poisoned")).toMatchObject({ clients: ["cursor"], inLockfile: true });

    const record = (await readLockfile(join(root, "latch.lock.example"))).servers.weather!.tools[0]!;
    await writePending(paths.stateDir, [{ id: "chg_1", serverId: "demo-poisoned", toolName: record.name, tier: 3, detectedAt: "2026-10-29T09:00:00.000Z", before: null, after: { ...record, serverId: "demo-poisoned" }, capabilityDelta: { gained: [], lost: [], loosened: [] }, findings: [] }]);

    expect(await removePreset(poisoned, undefined, paths)).toEqual({ clients: ["cursor"], lockfile: true });
    expect(JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers).toEqual({ mine: { command: "uvx", args: ["my-server"] } });
    expect((await readLockfile(paths.lockfilePath)).servers).toEqual({});
    expect(await readPending(paths.stateDir)).toEqual([]);
  });
});
