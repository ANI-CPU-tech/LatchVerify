import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printable } from "../commands/text.js";
import type { ClientId } from "../config/client-ids.js";
import { CLIENT_NAMES } from "../config/client-names.js";
import type { LatchEvent, PendingChange } from "../schema/index.js";

/** One desktop notification. `critical` stays on screen until dismissed where the desktop allows it. */
export interface DesktopNotification {
  title: string;
  body: string;
  urgency: "normal" | "critical";
}

/** Shows a notification; resolves once it was handed to the desktop (or could not be). Never throws. */
export type Notifier = (notification: DesktopNotification) => Promise<void>;

/** The app's id: the desktop entry and icon name on Linux, the AppUserModelID of the Start menu shortcut on Windows. */
export const APP_ID = "io.github.vinayakkam.LatchVerify";

const MAX_TITLE = 80;
const MAX_BODY = 240;
/** Tool names a summary spells out; the rest are counted. */
const NAMED = 3;

/** Server-controlled text made safe to show: control and invisible characters as [U+XXXX], then cut. */
function clean(text: string, max: number): string {
  const safe = printable(text);
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

const toolName = (serverId: string, tool: string) => `${serverId}/${tool}`;

/** What a pending change does to its tool, in a few words. */
function changeSummary(change: PendingChange): string {
  if (change.tier === 3) {
    const finding = change.findings.find((candidate) => candidate.severity === "critical");
    return finding === undefined ? "a high-risk change" : finding.message;
  }
  if (change.before === null) return "a new tool";
  const gained = change.capabilityDelta.gained;
  return gained.length > 0 ? `gained ${gained.join(", ")}` : "loosened its constraints";
}

/**
 * The notification shown when LatchVerify starts with changes waiting: how many, and the riskiest
 * first. Undefined for an empty queue.
 */
export function pendingSummary(queue: readonly PendingChange[]): DesktopNotification | undefined {
  if (queue.length === 0) return undefined;
  const ordered = [...queue].sort((a, b) => b.tier - a.tier);
  const highRisk = ordered.filter((change) => change.tier === 3).length;
  const names = ordered.slice(0, NAMED).map((change) => toolName(change.serverId, change.toolName));
  const more = queue.length - names.length;
  const title = queue.length === 1 ? "1 tool change waits for your review" : `${queue.length} tool changes wait for your review`;
  const risk = highRisk === 0 ? "" : highRisk === 1 ? "1 is high risk. " : `${highRisk} are high risk. `;
  const body = `${risk}${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Their calls are blocked until you approve or reject them.`;
  return { title: clean(title, MAX_TITLE), body: clean(body, MAX_BODY), urgency: highRisk > 0 ? "critical" : "normal" };
}

/** The notification for a change a proxy just queued. */
export function changeQueued(change: PendingChange): DesktopNotification {
  const name = toolName(change.serverId, change.toolName);
  const title = change.tier === 3 ? `High risk: ${name} changed` : `${name} changed and needs review`;
  const body = `${changeSummary(change)}. Its calls are blocked until you review it in LatchVerify.`;
  return { title: clean(title, MAX_TITLE), body: clean(body, MAX_BODY), urgency: change.tier === 3 ? "critical" : "normal" };
}

/** The notification for an MCP client found on this machine that the user has not been asked about. */
export function clientFound(client: ClientId, servers: number): DesktopNotification {
  const name = CLIENT_NAMES[client];
  return {
    title: clean(`Found ${name} with ${servers === 1 ? "1 MCP server" : `${servers} MCP servers`}`, MAX_TITLE),
    body: clean(`LatchVerify protects it only if you connect it: run \`latch setup\`, or choose Connect in LatchVerify. Nothing was changed.`, MAX_BODY),
    urgency: "normal",
  };
}

/** Why a call was blocked, from a call_blocked event's reason ("hard_block chg_..", "unpinned"). */
function blockReason(reason: string): string {
  switch (reason.split(" ")[0]) {
    case "hard_block":
      return "it changed in a high-risk way and waits for review";
    case "pending_review":
      return "it changed and waits for review";
    case "rejected":
      return "you rejected the definition it serves";
    case "unpinned":
      return "the tool is not approved in latch.lock yet";
    case "server_unpinned":
      return "its server is not pinned in latch.lock yet";
    case "unverified":
      return "its tools were not verified yet";
    default:
      return "LatchVerify could not check it";
  }
}

/** The notification for blocked calls of one tool: `count` of them since the last one shown. */
export function callsBlocked(event: Extract<LatchEvent, { kind: "call_blocked" }>, count = 1): DesktopNotification {
  const name = toolName(event.serverId, event.toolName);
  const title = `Blocked ${name}${count > 1 ? ` (${count} calls)` : ""}`;
  const urgent = event.reason.startsWith("hard_block");
  return { title: clean(title, MAX_TITLE), body: clean(`The AI client's call was stopped: ${blockReason(event.reason)}.`, MAX_BODY), urgency: urgent ? "critical" : "normal" };
}

/** The padlock icon: the built UI's (an install) or the source's (a checkout); else the installed icon's name. */
function linuxIcon(): string {
  const candidates = [new URL("../web/favicon.svg", import.meta.url), new URL("../../web/public/favicon.svg", import.meta.url)].map((url) => fileURLToPath(url));
  return candidates.find((path) => existsSync(path)) ?? APP_ID;
}

/** `name` on PATH, or undefined. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/** The notify-send arguments for `notification`: app name, icon, desktop entry and urgency. */
export function notifySendArgs(notification: DesktopNotification, icon: string): string[] {
  return [
    "--app-name=LatchVerify",
    `--icon=${icon}`,
    `--hint=string:desktop-entry:${APP_ID}`,
    `--urgency=${notification.urgency}`,
    "--",
    notification.title,
    notification.body,
  ];
}

const xmlEscape = (text: string) => text.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The toast XML for `notification`: title and body, with the alarm sound for a critical one. */
export function toastXml(notification: DesktopNotification): string {
  const audio = notification.urgency === "critical" ? '<audio src="ms-winsoundevent:Notification.Reminder"/>' : "<audio silent=\"false\"/>";
  return `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(notification.title)}</text><text>${xmlEscape(notification.body)}</text></binding></visual>${audio}</toast>`;
}

/**
 * Windows PowerShell 5.1 shows the toast through the WinRT API (PowerShell 7 dropped it). The XML
 * and the app id come in environment variables, so no notification text is ever quoted into a
 * command line.
 */
const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$xml.LoadXml($env:LATCH_TOAST_XML)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:LATCH_TOAST_APP).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("; ");

/** Runs a program, ignoring its output; resolves either way. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", env, windowsHide: true });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

/**
 * The desktop's notifier: notify-send on Linux (libnotify, present on GNOME, KDE, Xfce and most
 * others), a toast on Windows 10 and 11. Undefined where neither is available (a Linux without
 * notify-send, macOS), so callers can say notifications are off instead of failing silently.
 *
 * On Windows the toast is shown under APP_ID, the AppUserModelID the installer gives the Start
 * menu shortcut; Windows shows toasts only for an id a shortcut registers.
 */
export function desktopNotifier(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Notifier | undefined {
  if (platform === "linux") {
    const notifySend = onPath("notify-send", env);
    if (notifySend === undefined) return undefined;
    const icon = linuxIcon();
    return (notification) => run(notifySend, notifySendArgs(notification, icon), env);
  }
  if (platform === "win32") {
    const root = env.SystemRoot ?? "C:\\Windows";
    const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return (notification) =>
      run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT], {
        ...env,
        LATCH_TOAST_XML: toastXml(notification),
        LATCH_TOAST_APP: APP_ID,
      });
  }
  return undefined;
}
