import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, appMayStart, appRunning, installedApp, startAppIfStopped } from "../../src/desktop/launch.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-launch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("starting the app from a proxy", () => {
  it("finds the installed app beside the install-kind marker, and none in a checkout", async () => {
    const module = join(dir, "app", "dist", "desktop", "launch.js");
    expect(installedApp(module, "win32")).toBeUndefined();
    await mkdir(join(dir, "desktop"), { recursive: true });
    await writeFile(join(dir, "desktop", "latchverify-desktop.exe"), "");
    expect(installedApp(module, "win32")).toBeUndefined();
    await writeFile(join(dir, "install-kind"), "inno\n");
    expect(installedApp(module, "win32")).toBe(join(dir, "desktop", "latchverify-desktop.exe"));
    expect(installedApp(module, "linux")).toBeUndefined();
    expect(installedApp()).toBeUndefined();
  });

  it("reads the app as running only while its recorded pid is alive", async () => {
    const pid = join(dir, "app.pid");
    expect(appRunning(pid)).toBe(false);
    await writeFile(pid, `${process.pid}\n`);
    expect(appRunning(pid)).toBe(true);
    await writeFile(pid, "2147483646\n");
    expect(appRunning(pid)).toBe(false);
    await writeFile(pid, "garbage");
    expect(appRunning(pid)).toBe(false);
  });

  it("starts it hidden and detached when it is stopped, with none of the server's keys", async () => {
    const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const run = ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      return { unref() {}, on() {} };
    }) as never;
    const pidPath = join(dir, "app.pid");
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath, run, allowed: () => true })).toBe(true);
    expect(calls[0]).toMatchObject({ command: "/opt/latchverify/desktop/latchverify-desktop", args: ["--hidden"] });
    await writeFile(pidPath, `${process.pid}\n`);
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath, run, allowed: () => true })).toBe(false);
    expect(startAppIfStopped({ app: undefined, pidPath: join(dir, "none"), run, allowed: () => true })).toBe(false);
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath: join(dir, "none"), run, allowed: () => false })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("reads an empty pid file as stopped, not as process 0", async () => {
    const pid = join(dir, "app.pid");
    await writeFile(pid, "");
    expect(appRunning(pid)).toBe(false);
    await writeFile(pid, "0\n");
    expect(appRunning(pid)).toBe(false);
    await writeFile(pid, "-1\n");
    expect(appRunning(pid)).toBe(false);
  });

  it("survives an app that cannot start: the proxy runs either way", () => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const run = (() => child) as never;
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath: join(dir, "none"), run, allowed: () => true })).toBe(true);
    // A failed spawn reports an "error" event; with no listener, emit throws and the process dies.
    expect(() => child.emit("error", new Error("spawn EACCES"))).not.toThrow();
  });

  it("stays stopped when the user turned off starting in the background", async () => {
    const settings = join(dir, "settings.json");
    expect(appMayStart({ settingsPath: settings, platform: "win32", env: {} })).toBe(true);
    await writeFile(settings, JSON.stringify({ launchAtLogin: false }));
    expect(appMayStart({ settingsPath: settings, platform: "win32", env: {} })).toBe(false);
    await writeFile(settings, JSON.stringify({ launchAtLogin: true }));
    expect(appMayStart({ settingsPath: settings, platform: "win32", env: {} })).toBe(true);
    // A damaged file is the watcher's and the app's to report; the proxy just does not start anything.
    await writeFile(settings, "{ nope");
    expect(appMayStart({ settingsPath: settings, platform: "win32", env: {} })).toBe(false);
  });

  it("does not try to open a window on a Linux machine with no display", () => {
    const settingsPath = join(dir, "none.json");
    expect(appMayStart({ settingsPath, platform: "linux", env: {} })).toBe(false);
    expect(appMayStart({ settingsPath, platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(appMayStart({ settingsPath, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });

  it("starts it in a folder of its own, so a project's .env in the client's folder is not read", () => {
    const seen: Array<{ cwd?: string }> = [];
    const run = ((_command: string, _args: readonly string[], options: { cwd?: string }) => {
      seen.push(options);
      return { unref() {}, on() {} };
    }) as never;
    startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath: join(dir, "none"), run, allowed: () => true });
    expect(seen[0]!.cwd).toBe("/opt/latchverify/desktop");
  });

  it("passes the desktop session's variables on and drops everything else", () => {
    const env = appEnvironment({ PATH: "/bin", APPDATA: "C:\\a", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1", GITHUB_TOKEN: "sk-CANARY", OPENAI_API_KEY: "sk-CANARY", LATCH_STATE_DIR: "/x" });
    expect(env).toEqual({ PATH: "/bin", APPDATA: "C:\\a", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1" });
  });
});
