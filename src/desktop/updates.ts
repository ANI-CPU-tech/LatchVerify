import { app, dialog } from "electron";
import type { DesktopNotification } from "../daemon/notify.js";
import type { Logger } from "../log.js";
import { readSettings, settingsPath, updateSettings } from "../store/settings.js";
import { checkForUpdate, download, installKind, runInstall, type Offer } from "../update/index.js";
import { VERSION } from "../version.js";

/** What the window and the tray can do about updates. */
export interface UpdateHandlers {
  check(byUser: boolean): Promise<{ available: boolean; version?: string; error?: string }>;
  install(): Promise<{ installed: boolean; error?: string }>;
  /** The tray item's label. */
  label(): string;
  /** Starts the automatic checks; `changed` refreshes the tray. */
  schedule(changed: () => void): void;
}

const FIRST_CHECK_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Updates as GitPilot does them: a check 10 s after start and then daily (unless settings turn it
 * off), a notification when a release is out, and a dialog with its notes and Install now. Nothing
 * is downloaded before that click; the file is installed only once its sha256 matches the signed
 * manifest. Automatic check errors are only logged; a check the user asked for shows them.
 */
export function updateHandlers(deps: { notify: (notification: DesktopNotification) => Promise<void>; showWindow: (route?: string) => void; log: Logger }): UpdateHandlers {
  const install = installKind();
  let offer: Offer | undefined;
  let busy = false;
  const file = settingsPath();

  const check = async (byUser: boolean) => {
    if (install === undefined) {
      if (byUser) void dialog.showMessageBox({ type: "info", message: "This LatchVerify was built from source", detail: "It does not update itself: use git pull and pnpm build." });
      return { available: false, error: "not an installed release" };
    }
    try {
      const found = await checkForUpdate(install.kind);
      await updateSettings(file, { lastUpdateCheck: new Date().toISOString() }).catch(() => undefined);
      const fresh = found !== undefined && found.version !== offer?.version;
      offer = found;
      if (found === undefined) {
        if (byUser) void dialog.showMessageBox({ type: "info", message: `LatchVerify ${VERSION} is the latest release` });
        return { available: false };
      }
      if (byUser) void handlers.install();
      else if (fresh) await deps.notify({ title: `LatchVerify ${found.version} is available`, body: "Open the tray menu and choose Install update.", urgency: "normal" });
      return { available: true, version: found.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (byUser) void dialog.showMessageBox({ type: "error", message: "Could not check for updates", detail: message });
      else deps.log.warn(`update check failed: ${message}`);
      return { available: false, error: message };
    }
  };

  const handlers: UpdateHandlers = {
    check,
    install: async () => {
      if (offer === undefined || install === undefined || busy) return { installed: false, error: offer === undefined ? "no update is available" : "an update is already being installed" };
      const choice = await dialog.showMessageBox({
        type: "info",
        buttons: ["Install now", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `Install LatchVerify ${offer.version}?`,
        detail: `${offer.notes.trim().slice(0, 4000)}\n\nYou have ${VERSION}. ${install.kind === "inno" ? "Running MCP servers may be closed by the installer; restart your MCP clients afterwards." : "Restart your MCP clients afterwards."}`,
      });
      if (choice.response !== 0) return { installed: false };
      busy = true;
      try {
        const downloaded = await download(offer);
        const code = await runInstall(install.kind, downloaded, install.root);
        if (code !== 0) throw new Error(`the installer exited with ${code}`);
        if (install.kind === "inno") app.quit();
        else {
          app.relaunch();
          app.exit(0);
        }
        return { installed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void dialog.showMessageBox({ type: "error", message: "The update was not installed", detail: message });
        return { installed: false, error: message };
      } finally {
        busy = false;
      }
    },
    label: () => (offer === undefined ? "Check for updates" : `Install LatchVerify ${offer.version}...`),
    schedule: (changed) => {
      const automatic = async () => {
        const settings = await readSettings(file).catch(() => undefined);
        if (settings?.checkForUpdates === false) return;
        const last = settings?.lastUpdateCheck === undefined ? 0 : Date.parse(settings.lastUpdateCheck);
        if (Date.now() - last < DAY_MS - 60_000 && offer === undefined) return;
        await check(false);
        changed();
      };
      setTimeout(() => void automatic(), FIRST_CHECK_MS).unref();
      setInterval(() => void automatic(), 60 * 60 * 1000).unref();
    },
  };
  return handlers;
}
