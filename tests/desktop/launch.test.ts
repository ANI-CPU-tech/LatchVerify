import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, appRunning, installedApp, startAppIfStopped } from "../../src/desktop/launch.js";

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
      return { unref() {} };
    }) as never;
    const pidPath = join(dir, "app.pid");
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath, run })).toBe(true);
    expect(calls[0]).toMatchObject({ command: "/opt/latchverify/desktop/latchverify-desktop", args: ["--hidden"] });
    await writeFile(pidPath, `${process.pid}\n`);
    expect(startAppIfStopped({ app: "/opt/latchverify/desktop/latchverify-desktop", pidPath, run })).toBe(false);
    expect(startAppIfStopped({ app: undefined, pidPath: join(dir, "none"), run })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("passes the desktop session's variables on and drops everything else", () => {
    const env = appEnvironment({ PATH: "/bin", APPDATA: "C:\\a", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1", GITHUB_TOKEN: "sk-CANARY", OPENAI_API_KEY: "sk-CANARY", LATCH_STATE_DIR: "/x" });
    expect(env).toEqual({ PATH: "/bin", APPDATA: "C:\\a", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1" });
  });
});
