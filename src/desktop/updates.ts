import { app, dialog } from "electron";
import type { DesktopNotification } from "../daemon/notify.js";
import type { Logger } from "../log.js";
import { readSettings, settingsPath, updateSettings } from "../store/settings.js";
import { checkForUpdate, download, installKind, privilegeFailure, runInstall, runUninstall, type Offer } from "../update/index.js";
import { VERSION } from "../version.js";

/** What the Settings page shows about updates (the window's bridge, preload.cts). */
export interface UpdateStatus {
  /** The running version. */
  current: string;
  /** False in a source checkout, which neither updates nor uninstalls itself. */
  installed: boolean;
  /** The release on offer, if a check found one. */
  offer?: { version: string; notes: string };
  /** When updates were last checked for (ISO), if ever. */
  lastCheck?: string;
  /** A download or install is running. */
  busy: boolean;
}

/**
 * How a check reports: "auto" notifies on a new release and logs errors, "dialog" (the tray) shows
 * native dialogs and offers the install, "inline" (Settings) only returns what it found.
 */
export type CheckMode = "auto" | "dialog" | "inline";

/** What the window and the tray can do about updates. */
export interface UpdateHandlers {
  check(mode: CheckMode): Promise<{ available: boolean; version?: string; error?: string }>;
  /** Installs the offer; `confirm` asks first in a dialog (the tray). Settings shows the notes itself. */
  install(confirm?: boolean): Promise<{ installed: boolean; error?: string }>;
  status(): Promise<UpdateStatus>;
  /** Asks, then removes LatchVerify with its own uninstaller. */
  uninstall(): Promise<{ started: boolean; error?: string }>;
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

  const check = async (mode: CheckMode) => {
    const byUser = mode === "dialog";
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
      if (byUser) void handlers.install(true);
      else if (mode === "auto" && fresh) await deps.notify({ title: `LatchVerify ${found.version} is available`, body: "Open the tray menu and choose Install update.", urgency: "normal" });
      return { available: true, version: found.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (byUser) void dialog.showMessageBox({ type: "error", message: "Could not check for updates", detail: message });
      else if (mode === "auto") deps.log.warn(`update check failed: ${message}`);
      return { available: false, error: message };
    }
  };

  const handlers: UpdateHandlers = {
    check,
    install: async (confirm = false) => {
      if (offer === undefined || install === undefined || busy) return { installed: false, error: offer === undefined ? "no update is available" : "an update is already being installed" };
      if (confirm) {
        const choice = await dialog.showMessageBox({
        type: "info",
        buttons: ["Install now", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `Install LatchVerify ${offer.version}?`,
          detail: `${offer.notes.trim().slice(0, 4000)}\n\nYou have ${VERSION}. ${install.kind === "inno" ? "Running MCP servers may be closed by the installer; restart your MCP clients afterwards." : "Restart your MCP clients afterwards."}`,
        });
        if (choice.response !== 0) return { installed: false };
      }
      busy = true;
      try {
        const downloaded = await download(offer);
        const code = await runInstall(install.kind, downloaded, install.root);
        if (code !== 0) throw new Error(privilegeFailure(install.kind, code) ?? `the installer exited with ${code}`);
        if (install.kind === "inno") app.quit();
        else {
          app.relaunch();
          app.exit(0);
        }
        return { installed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (confirm) void dialog.showMessageBox({ type: "error", message: "The update was not installed", detail: message });
        return { installed: false, error: message };
      } finally {
        busy = false;
      }
    },
    status: async () => {
      const settings = await readSettings(file).catch(() => undefined);
      return {
        current: VERSION,
        installed: install !== undefined,
        ...(offer === undefined ? {} : { offer: { version: offer.version, notes: offer.notes } }),
        ...(settings?.lastUpdateCheck === undefined ? {} : { lastCheck: settings.lastUpdateCheck }),
        busy,
      };
    },
    uninstall: async () => {
      if (install === undefined) return { started: false, error: "this LatchVerify was built from source; delete the checkout instead" };
      if (busy) return { started: false, error: "an update is being installed" };
      // The Windows uninstaller asks for itself; on Linux this is the only question.
      if (install.kind !== "inno") {
        const choice = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Uninstall", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Uninstall LatchVerify?",
          detail: "Every MCP client gets its original server commands back, so its servers start without LatchVerify's checks. Your latch.lock and settings are kept, so reinstalling keeps your approvals.",
        });
        if (choice.response !== 0) return { started: false };
      }
      busy = true;
      try {
        const code = await runUninstall(install.kind, install.root);
        if (code !== 0) throw new Error(privilegeFailure(install.kind, code) ?? `the uninstaller exited with ${code}`);
        // The uninstallers stop the app; quit in case this one was not matched.
        if (install.kind !== "inno") app.exit(0);
        return { started: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void dialog.showMessageBox({ type: "error", message: "LatchVerify was not uninstalled", detail: message });
        return { started: false, error: message };
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
        await check("auto");
        changed();
      };
      setTimeout(() => void automatic(), FIRST_CHECK_MS).unref();
      setInterval(() => void automatic(), 60 * 60 * 1000).unref();
    },
  };
  return handlers;
}
