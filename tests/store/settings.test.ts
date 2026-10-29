import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsPatchSchema } from "../../src/schema/index.js";
import { SettingsError, clientEnabled, readSettings, settingsPath, updateSettings } from "../../src/store/settings.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-settings-"));
  path = join(dir, "latchverify", "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settingsPath", () => {
  it("sits beside the per-user latch.lock", () => {
    expect(settingsPath("linux", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/latchverify/settings.json");
    expect(settingsPath("win32", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" })).toBe("C:\\Users\\dev\\AppData\\Roaming\\LatchVerify\\settings.json");
  });
});

describe("readSettings", () => {
  it("gives the defaults when there is no file", async () => {
    expect(await readSettings(path)).toEqual({ clients: {}, notifications: true, checkForUpdates: true, launchAtLogin: true });
    expect(await readSettings(path)).toEqual(DEFAULT_SETTINGS);
  });

  it("fills in what a partial file leaves out", async () => {
    await updateSettings(path, {});
    await writeFile(path, '{ "notifications": false }');
    expect(await readSettings(path)).toEqual({ ...DEFAULT_SETTINGS, notifications: false });
  });

  it("refuses a file that is not valid settings, naming it", async () => {
    await updateSettings(path, {});
    await writeFile(path, "{ nope");
    await expect(readSettings(path)).rejects.toThrow(SettingsError);
    await writeFile(path, '{ "clients": { "notepad": true } }');
    await expect(readSettings(path)).rejects.toThrow(`${path} is not valid settings`);
  });
});

describe("updateSettings", () => {
  it("merges client choices one by one and writes the whole file", async () => {
    await updateSettings(path, { clients: { cursor: false } });
    const next = await updateSettings(path, { clients: { zed: false }, notifications: false });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, clients: { cursor: false, zed: false }, notifications: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
  });

  it("keeps every concurrent change", async () => {
    await Promise.all((["cursor", "zed", "vscode", "cline"] as const).map((client) => updateSettings(path, { clients: { [client]: false } })));
    expect((await readSettings(path)).clients).toEqual({ cursor: false, zed: false, vscode: false, cline: false });
  });

  it("only takes known fields and values", () => {
    expect(SettingsPatchSchema.safeParse({ notifications: "yes" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ theme: "dark" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ clients: { notepad: false } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ clients: { cursor: false } }).success).toBe(true);
  });
});

describe("clientEnabled", () => {
  it("is true unless the client was turned off", () => {
    expect(clientEnabled(DEFAULT_SETTINGS, "cursor")).toBe(true);
    expect(clientEnabled({ ...DEFAULT_SETTINGS, clients: { cursor: true } }, "cursor")).toBe(true);
    expect(clientEnabled({ ...DEFAULT_SETTINGS, clients: { cursor: false } }, "cursor")).toBe(false);
  });
});
