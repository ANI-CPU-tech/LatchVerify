// Start the installed LatchVerify app from a proxy, hidden in the tray, when it is not running:
// opening an MCP client then brings the app (notifications, review queue) up with it. No Electron
// import here: proxies load this module, and they stay plain, light Node processes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userLockfilePath } from "../config/paths.js";

/** Where the running app records its pid: beside the per-user latch.lock. */
export function appPidPath(): string {
  return join(dirname(userLockfilePath()), "app.pid");
}

/**
 * True when the pid in `path` is a live process.
 * shortcut: a reused pid reads as running and the app is not started, until the next login.
 */
export function appRunning(path: string = appPidPath()): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    // An empty file reads as 0, and signalling 0 means this process's whole group, which always answers.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The installed app's executable, found from this module (<install>/app/dist/desktop/launch.js)
 * next to the install-kind marker the installers write; undefined in a source checkout.
 */
export function installedApp(from: string = fileURLToPath(import.meta.url), platform: NodeJS.Platform = process.platform): string | undefined {
  const root = dirname(dirname(dirname(dirname(from))));
  const app = join(root, "desktop", platform === "win32" ? "latchverify-desktop.exe" : "latchverify-desktop");
  return existsSync(join(root, "install-kind")) && existsSync(app) ? app : undefined;
}

/** Variables a desktop app needs to run; anything else, such as a server's keys, stays behind. */
const APP_ENV = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+|DESKTOP_SESSION)$/i;

/** The proxy runs with the client's env for its server, keys included; the app gets the session's basics only. */
export function appEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => APP_ENV.test(name)));
}

/**
 * Whether a proxy may start the app: not when the user turned off starting it in the background
 * (settings.json, read here without the settings module to keep proxies light; a file that cannot
 * be read counts as off, the app and the watcher report it), and not on Linux without a display,
 * such as over SSH, where a window could not open.
 */
export function appMayStart({
  settingsPath = join(dirname(userLockfilePath()), "settings.json"),
  platform = process.platform,
  env = process.env,
}: { settingsPath?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    return (JSON.parse(text) as { launchAtLogin?: unknown }).launchAtLogin !== false;
  } catch {
    return false;
  }
}

/** Start the installed app hidden when it is not running. Never throws or lets a failed start end the proxy: it runs either way. */
export function startAppIfStopped({ app = installedApp(), pidPath = appPidPath(), run = spawn, allowed = () => appMayStart() } = {}): boolean {
  try {
    if (app === undefined || !allowed() || appRunning(pidPath)) return false;
    // Several proxies may start at once; the app's single-instance lock keeps one copy.
    // In the app's own folder: the client's working directory may be any project.
    const child = run(app, ["--hidden"], { detached: true, stdio: "ignore", env: appEnvironment(process.env), cwd: dirname(app) });
    // A spawn that fails later (permissions, a broken install) arrives as this event.
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
