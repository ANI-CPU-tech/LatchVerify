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
}

export function parseFlags(argv: readonly string[]): AppFlags {
  return { hidden: argv.includes("--hidden"), smoke: argv.includes("--smoke"), dev: argv.includes("--dev") };
}

/** True when the window may load `url`: only the app's own review server, never another origin. */
export function navigationAllowed(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
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
  return ["[Desktop Entry]", "Type=Application", "Name=LatchVerify", "Comment=Keeps your MCP clients behind LatchVerify", `Exec=${quoted} --hidden`, "Icon=io.github.vinayakkam.LatchVerify", "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n");
}

/** The route a notification click opens. */
export const REVIEW_ROUTE = "#/review";

