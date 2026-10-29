import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { platformPath, userLockfilePath } from "../config/paths.js";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type SettingsPatch } from "../schema/index.js";
import { withFileLock } from "./lock.js";
import { writeFileAtomic } from "./replace.js";

/** settings.json, beside the per-user latch.lock: %APPDATA%\LatchVerify, ~/.config/latchverify. */
export function settingsPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const path = platformPath(platform);
  return path.join(path.dirname(userLockfilePath(platform, env)), "settings.json");
}

/** The file holds something that is not valid settings. It is never overwritten silently. */
export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/** The settings in `path`; the defaults when the file does not exist. */
export async function readSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; fix or delete it to get the default settings back`);
  }
  const result = SettingsSchema.safeParse(value);
  if (!result.success) throw new SettingsError(`${path} is not valid settings:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Applies `patch` to the settings in `path` under a lock (<path>.lock) and writes them
 * atomically. `clients` is merged per client, so turning one client off keeps the others' choices.
 * Returns the settings as written.
 */
export async function updateSettings(path: string, patch: SettingsPatch): Promise<Settings> {
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, async () => {
    const current = await readSettings(path);
    const next = SettingsSchema.parse({ ...current, ...patch, clients: { ...current.clients, ...patch.clients } });
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/** True unless the user turned `client` off. */
export function clientEnabled(settings: Settings, client: keyof Settings["clients"]): boolean {
  return settings.clients[client] !== false;
}
