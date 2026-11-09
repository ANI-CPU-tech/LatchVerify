/**
 * Which download to suggest, from the browser's user agent. A guess, used only to put one button
 * first: every package stays one click away. Pure, tested in tests/site/platform.test.ts.
 */
import type { PackageKind } from "./release.js";

export type Platform = "windows" | "linux" | "mac" | "mobile" | "other";

/**
 * @param userAgent navigator.userAgent
 * @param hintPlatform navigator.userAgentData?.platform where the browser has it ("Windows",
 *   "macOS", "Linux", "Android", "Chrome OS", ...); it wins over the user agent string.
 */
export function detectPlatform(userAgent: string, hintPlatform?: string): Platform {
  const hint = hintPlatform?.toLowerCase() ?? "";
  if (/android|ios/.test(hint)) return "mobile";
  if (hint === "windows") return "windows";
  if (hint === "macos") return "mac";
  if (hint === "linux") return "linux";
  // Android user agents also say "Linux", so phones and tablets come first.
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return "mobile";
  if (/Windows NT|Win64|Win32/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac";
  if (/CrOS/i.test(userAgent)) return "other";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return "other";
}

/**
 * The package to suggest, or null when the platform has none (macOS, phones) or the Linux
 * distribution is unknown: most Linux user agents do not say which one they run.
 */
export function suggestedPackage(platform: Platform, userAgent: string): PackageKind | null {
  if (platform === "windows") return "windows";
  if (platform !== "linux") return null;
  if (/Ubuntu|Debian|Mint|Pop!_OS/i.test(userAgent)) return "deb";
  if (/Arch|Manjaro|CachyOS|EndeavourOS|Garuda/i.test(userAgent)) return "arch";
  return null;
}
