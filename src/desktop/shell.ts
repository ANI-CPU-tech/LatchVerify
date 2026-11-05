import { posix } from "node:path";

/**
 * The desktop app's decisions that need no Electron, so they are tested in node: start-up flags,
 * which navigations the window allows, the tray menu, and the Linux autostart entry.
 */

/** Command-line flags of the app. */
export interface AppFlags {
  /** Start in the tray, with no window (what login start uses). */
  hidden: boolean;
  /** Start the services, report and quit: for packaging smoke tests. */
  smoke: boolean;
  /** Development mode, as LATCH_DEV. */
  dev: boolean;
  /** Ask to uninstall LatchVerify (the Linux menu entry's Uninstall action). */
  uninstall: boolean;
}

export function parseFlags(argv: readonly string[]): AppFlags {
  return { hidden: argv.includes("--hidden"), smoke: argv.includes("--smoke"), dev: argv.includes("--dev"), uninstall: argv.includes("--uninstall") };
}

/**
 * The scheme the window loads the review UI from (main.ts serves it with protocol.handle): one
 * origin on every start, so what the UI keeps in localStorage (theme, card opacity) stays, and no
 * port is opened, so no other program on the machine reaches the API.
 */
export const APP_SCHEME = "latchverify";
/** The window's base URL. */
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * True when the window may load `url`: only the app's own origin, never another. Compared by
 * scheme and host, not URL.origin, which is "null" for every non-web scheme alike.
 */
export function navigationAllowed(url: string, base: string): boolean {
  try {
    const target = new URL(url);
    const own = new URL(base);
    return target.protocol === own.protocol && target.host === own.host;
  } catch {
    return false;
  }
}

/**
 * A request the window sent to APP_ORIGIN, as the review API expects it: on 127.0.0.1, and from a
 * loopback origin when it names one. Only the app's own window can send these (the scheme exists
 * in its session alone), so it stands in for the loopback check a TCP server needs.
 *
 * @throws TypeError for a request to any other origin.
 */
export function loopbackRequest(request: Request): Request {
  const from = new URL(request.url);
  if (from.protocol !== `${APP_SCHEME}:` || from.host !== "app") throw new TypeError(`not a ${APP_ORIGIN} request: ${request.url}`);
  const headers = new Headers(request.headers);
  if (headers.has("origin")) headers.set("origin", "http://127.0.0.1");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(`http://127.0.0.1${from.pathname}${from.search}`, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit);
}

/** One tray menu item: an action the app runs, or a separator. */
export type TrayItem = { id: TrayAction; label: string; enabled?: boolean } | { separator: true };
export type TrayAction = "open" | "review" | "pause" | "updates" | "quit";

/** The tray menu for the current state. */
export function trayMenu(state: { pending: number; paused: boolean; updateLabel: string }): TrayItem[] {
  return [
    { id: "open", label: "Open LatchVerify" },
    { id: "review", label: state.pending === 0 ? "Review queue (empty)" : `Review queue (${state.pending})`, enabled: state.pending > 0 },
    { separator: true },
    { id: "pause", label: state.paused ? "Resume watching MCP clients" : "Pause watching MCP clients" },
    { id: "updates", label: state.updateLabel },
    { separator: true },
    { id: "quit", label: "Quit LatchVerify" },
  ];
}

/** The tray tooltip: what LatchVerify is doing, and what waits. */
export function trayTooltip(state: { pending: number; paused: boolean }): string {
  const watching = state.paused ? "paused" : "watching your MCP clients";
  return state.pending === 0 ? `LatchVerify: ${watching}` : `LatchVerify: ${state.pending} ${state.pending === 1 ? "change waits" : "changes wait"} for review`;
}

/** ~/.config/autostart/latchverify.desktop (XDG autostart), for login start on Linux. */
export function autostartPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME !== undefined && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(home, ".config");
  return posix.join(config, "autostart", "latchverify.desktop");
}

/** The autostart entry starting `executable` hidden in the tray. The path is quoted per the Desktop Entry spec. */
export function autostartEntry(executable: string): string {
  const quoted = `"${executable.replace(/(["`$\\])/g, "\\$1")}"`;
  return ["[Desktop Entry]", "Type=Application", "Name=LatchVerify", "Comment=Keeps your MCP clients behind LatchVerify", `Exec=${quoted} --hidden`, "Icon=io.github.ANI-CPU-tech.LatchVerify", "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n");
}

/** The route a notification click opens. */
export const REVIEW_ROUTE = "#/review";

