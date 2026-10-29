import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAdd } from "../commands/add.js";
import { SUPPORTED_CLIENTS, clientLocations, detectClients, removeClientServer, type ClientId } from "../config/clients.js";
import { readLockfile, removeServer, writeLockfile } from "../store/lockfile.js";
import { updatePending, withStateLock } from "../store/pending.js";

/**
 * The demo servers of this repository (demo/), as presets a developer adds to an MCP client in one
 * step: from the Dev Tools page (development mode only) or `pnpm demo:add`. They exist only in a
 * source checkout: an installed LatchVerify ships no demo/ and reports them unavailable. The demo
 * is referenced by path at run time, never imported, so no package ever carries it.
 */
export interface DemoPreset {
  /** Server id the preset is added under. Prefixed, so it never collides with a real server. */
  id: string;
  name: string;
  description: string;
  /** Under demo/. */
  script: string;
  env: Record<string, string>;
}

export const DEMO_PRESETS: readonly DemoPreset[] = [
  {
    id: "demo-weather",
    name: "Weather",
    description: "The benign weather server: two read-only tools, pinned on its first run.",
    script: "weather-server.ts",
    env: {},
  },
  {
    id: "demo-rugpull",
    name: "Weather rug pull",
    description: "Starts identical to the weather server and swaps in poisoned tools after its third call. LatchVerify blocks them.",
    script: "evil-server.ts",
    env: {},
  },
  {
    id: "demo-poisoned",
    name: "Poisoned weather",
    description: "Serves the poisoned tools from the start: on its first run only read_config is pinned, the rest wait for review.",
    script: "evil-server.ts",
    env: { DEMO_MUTATE: "1" },
  },
  {
    id: "demo-devtools",
    name: "DevTools",
    description: "An unrestricted shell tool, held for review on first run, and a format_json rug pull after the third call.",
    script: "devtools-server.ts",
    env: {},
  },
];

/** The checkout this module runs from (src/dev or dist/dev, two levels down), when it has demo/ and tsx. */
export function demoRoot(): string | undefined {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (!existsSync(join(root, "demo", "weather-server.ts"))) return undefined;
  try {
    createRequire(join(root, "package.json")).resolve("tsx");
    return root;
  } catch {
    return undefined;
  }
}

/** How a preset is started: this node, with tsx's loader, on the demo script, all by absolute path. */
export function presetLaunch(preset: DemoPreset, root: string): { command: string; args: string[] } {
  const tsx = pathToFileURL(createRequire(join(root, "package.json")).resolve("tsx")).href;
  return { command: process.execPath, args: ["--import", tsx, join(root, "demo", preset.script)] };
}

export function findPreset(id: string): DemoPreset | undefined {
  return DEMO_PRESETS.find((preset) => preset.id === id);
}

export interface PresetState extends Omit<DemoPreset, "env" | "script"> {
  /** Clients whose config has the preset's server. */
  clients: ClientId[];
  /** Whether latch.lock lists it. */
  inLockfile: boolean;
}

/** Each preset, with where it is installed. */
export async function presetStates(lockfilePath: string): Promise<PresetState[]> {
  const [{ configs }, lock] = await Promise.all([detectClients(), readLockfile(lockfilePath)]);
  return DEMO_PRESETS.map(({ id, name, description }) => ({
    id,
    name,
    description,
    clients: [...new Set(configs.filter((config) => config.serverIds.includes(id)).map((config) => config.client))],
    inLockfile: Object.hasOwn(lock.servers, id),
  }));
}

export interface PresetPaths {
  lockfilePath: string;
  stateDir: string;
}

/** Adds a preset to `client` with `latch add`: linked in latch.lock, pinned on its first run. Resolves add's exit code. */
export async function addPreset(preset: DemoPreset, client: ClientId, paths: PresetPaths, output: Writable): Promise<number> {
  const root = demoRoot();
  if (root === undefined) throw new Error("the demo servers are not here: this is not a source checkout with demo/ and tsx");
  const launch = presetLaunch(preset, root);
  return runAdd({
    name: preset.id,
    command: [launch.command, ...launch.args],
    client,
    env: Object.entries(preset.env).map(([key, value]) => `${key}=${value}`),
    dryRun: false,
    output,
    ...paths,
  });
}

/**
 * Removes a preset: its entry from `client`'s config (or every client's when none is given), and,
 * once no client has it, its record in latch.lock and its queued changes. Only preset ids are ever
 * removed, so a real server is never touched. Resolves what was removed.
 */
export async function removePreset(preset: DemoPreset, client: ClientId | undefined, paths: PresetPaths): Promise<{ clients: ClientId[]; lockfile: boolean }> {
  const removed: ClientId[] = [];
  for (const id of client === undefined ? SUPPORTED_CLIENTS : [client]) {
    for (const location of clientLocations(id)) if (await removeClientServer(location, preset.id)) removed.push(id);
  }
  const stillUsed = (await detectClients()).configs.some((config) => config.serverIds.includes(preset.id));
  let lockfile = false;
  if (!stillUsed) {
    lockfile = await withStateLock(paths.stateDir, async () => {
      const lock = await readLockfile(paths.lockfilePath);
      if (!Object.hasOwn(lock.servers, preset.id)) return false;
      await writeLockfile(paths.lockfilePath, removeServer(lock, preset.id));
      return true;
    });
    await updatePending(paths.stateDir, (queue) => {
      const kept = queue.filter((change) => change.serverId !== preset.id);
      return kept.length === queue.length ? queue : kept;
    });
  }
  return { clients: [...new Set(removed)], lockfile };
}
