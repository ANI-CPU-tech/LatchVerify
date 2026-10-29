// The LatchVerify desktop app (Electron main process): the review UI in its own window, a tray
// icon, the background watcher with native notifications, and start at login. It runs the same
// review server and watcher as `latch review --ui` and `latch watch`, in one process; the proxies
// stay plain Node processes started by the MCP clients.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Notification, Tray, app, ipcMain, nativeImage, type MenuItemConstructorOptions } from "electron";
import { loadDotEnv, loadEnv } from "../config/env.js";
import { userLockfilePath } from "../config/paths.js";
import { defaultReviewer } from "../config/reviewer.js";
import { APP_ID, type DesktopNotification } from "../daemon/notify.js";
import { startWatcher, type Watcher } from "../daemon/watch.js";
import { createLogger } from "../log.js";
import { emptyLockfile, writeLockfile } from "../store/lockfile.js";
import { readPending } from "../store/pending.js";
import { readSettings, settingsPath } from "../store/settings.js";
import { startUiServer, type UiServerHandle } from "../ui/server.js";
import { VERSION } from "../version.js";
import { REVIEW_ROUTE, autostartEntry, autostartPath, navigationAllowed, parseFlags, trayMenu, trayTooltip, type TrayAction } from "./shell.js";
import { updateHandlers } from "./updates.js";

const flags = parseFlags(process.argv);
const log = createLogger(process.env.LATCH_LOG_LEVEL === "debug" ? "debug" : "info");
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const WEB_DIR = here("../web/");
const ICON = here("../web/icon-256.png");
const TRAY_ICON = here("../web/icon-32.png");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main().catch((error: unknown) => {
    log.error(`LatchVerify could not start: ${error instanceof Error ? error.stack : String(error)}`);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  // Windows ties notifications, the taskbar and the login start to the Start menu shortcut's id.
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);
  loadDotEnv();
  const env = loadEnv();
  const lockfilePath = userLockfilePath();
  const stateDir = join(dirname(lockfilePath), ".latch");
  const settingsFile = settingsPath();
  if (!existsSync(lockfilePath)) {
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
  }

  await app.whenReady();
  // The app has its own window only: no application menu.
  Menu.setApplicationMenu(null);

  const server: UiServerHandle = await startUiServer({
    port: 0,
    lockfilePath,
    stateDir,
    settingsPath: settingsFile,
    reviewer: defaultReviewer(),
    staticDir: WEB_DIR,
    dev: env.dev || flags.dev,
  });

  let window: BrowserWindow | undefined;
  let quitting = false;
  const showWindow = (route = "#/") => {
    if (window === undefined || window.isDestroyed()) window = createWindow(server.url);
    void window.loadURL(`${server.url}/${route}`);
    window.show();
    window.focus();
  };

  const notify = async (notification: DesktopNotification) => {
    if (!Notification.isSupported()) return;
    const shown = new Notification({ title: notification.title, body: notification.body, urgency: notification.urgency, icon: ICON, silent: false });
    shown.on("click", () => showWindow(REVIEW_ROUTE));
    shown.show();
  };

  let watcher: Watcher | undefined;
  const startWatching = async () => {
    watcher = await startWatcher({
      lockfilePath,
      stateDir,
      settingsPath: settingsFile,
      log,
      notify,
      onSync: () => void applyLoginStart(settingsFile),
    });
  };

  if (flags.smoke) {
    await startWatching();
    process.stdout.write(`latchverify desktop ${VERSION}: review server on ${server.url}, watcher running\n`);
    await watcher!.close();
    await server.close();
    app.exit(0);
    return;
  }

  await startWatching();
  await applyLoginStart(settingsFile);
  const updates = updateHandlers({ notify, showWindow, log });
  ipcMain.handle("latch:version", () => VERSION);
  ipcMain.handle("latch:check-for-updates", () => updates.check(true));
  ipcMain.handle("latch:install-update", () => updates.install());

  // Tray: the app lives here; closing the window only hides it.
  const tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  let paused = false;
  let pending = 0;
  const refreshTray = () => {
    tray.setToolTip(trayTooltip({ pending, paused }));
    const items = trayMenu({ pending, paused, updateLabel: updates.label() }).map(
      (item): MenuItemConstructorOptions => ("separator" in item ? { type: "separator" } : { label: item.label, enabled: item.enabled ?? true, click: () => void act(item.id) }),
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  const act = async (action: TrayAction) => {
    switch (action) {
      case "open":
        return showWindow();
      case "review":
        return showWindow(REVIEW_ROUTE);
      case "pause":
        if (paused) await startWatching();
        else await watcher?.close();
        paused = !paused;
        return refreshTray();
      case "updates":
        if (updates.label().startsWith("Install")) await updates.install();
        else await updates.check(true);
        return refreshTray();
      case "quit":
        quitting = true;
        return app.quit();
    }
  };
  tray.on("click", () => showWindow());
  // The queue count is a file read every few seconds: proxies write it, not this process.
  const poll = setInterval(() => {
    void readPending(stateDir).then(
      (queue) => {
        if (queue.length !== pending) {
          pending = queue.length;
          refreshTray();
        }
      },
      () => undefined,
    );
  }, 5000);
  refreshTray();
  updates.schedule(refreshTray);

  app.on("second-instance", () => showWindow());
  // Stay in the tray when the window closes.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(poll);
    void watcher?.close();
    void server.close();
  });

  if (!flags.hidden) showWindow();

  function createWindow(base: string): BrowserWindow {
    const created = new BrowserWindow({
      width: 1200,
      height: 820,
      minWidth: 720,
      minHeight: 520,
      show: false,
      icon: ICON,
      title: "LatchVerify",
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: here("./preload.cjs") },
    });
    // Nothing leaves the app's own server: no new windows, no navigation elsewhere.
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event, url) => {
      if (!navigationAllowed(url, base)) event.preventDefault();
    });
    created.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      created.hide();
    });
    return created;
  }
}

/** Login start as settings.json says: a login item on Windows and macOS, an XDG autostart entry on Linux. */
async function applyLoginStart(settingsFile: string): Promise<void> {
  // Only an installed app registers itself; `pnpm desktop` from a checkout never does.
  if (!app.isPackaged) return;
  let enabled = true;
  try {
    enabled = (await readSettings(settingsFile)).launchAtLogin;
  } catch {
    return;
  }
  if (process.platform === "linux") {
    const path = autostartPath(homedir());
    if (enabled) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, autostartEntry(process.env.APPIMAGE ?? process.execPath));
    } else {
      await rm(path, { force: true });
    }
    return;
  }
  // The installer removes this Run value by name when LatchVerify is uninstalled.
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"], name: APP_ID });
}
