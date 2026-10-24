import { homedir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";

/** Path functions for `platform`, so paths can be built for another OS in tests. */
export function platformPath(platform: NodeJS.Platform = process.platform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

/**
 * The per-user application data directory on `platform`: ~/Library/Application Support on macOS,
 * %APPDATA% on Windows (falling back to ~/AppData/Roaming), and $XDG_CONFIG_HOME or ~/.config
 * elsewhere. ~ is os.homedir(), so HOME (USERPROFILE on Windows) redirects it.
 */
export function appDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const path = platformPath(platform);
  const home = homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return absoluteOrUndefined(env.APPDATA, path) ?? path.join(home, "AppData", "Roaming");
  // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
  return absoluteOrUndefined(env.XDG_CONFIG_HOME, path) ?? path.join(home, ".config");
}

function absoluteOrUndefined(value: string | undefined, path: PlatformPath): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

/**
 * The per-user latch.lock that `latch setup` creates and links clients to, so an installed latch
 * protects the user's own MCP servers without a project checkout:
 *
 * | Platform | Path                                                        |
 * |----------|-------------------------------------------------------------|
 * | Windows  | %APPDATA%\LatchVerify\latch.lock                            |
 * | macOS    | ~/Library/Application Support/LatchVerify/latch.lock        |
 * | Linux    | $XDG_CONFIG_HOME/latchverify/latch.lock (~/.config/...)     |
 *
 * Its state directory is the usual .latch next to it.
 */
export function userLockfilePath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const folder = platform === "win32" || platform === "darwin" ? "LatchVerify" : "latchverify";
  return platformPath(platform).join(appDataDir(platform, env), folder, "latch.lock");
}
