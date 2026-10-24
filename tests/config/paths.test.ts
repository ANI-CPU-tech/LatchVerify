import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { appDataDir, userLockfilePath } from "../../src/config/paths.js";

describe("appDataDir", () => {
  it("follows each platform's convention", () => {
    expect(appDataDir("darwin", {})).toBe(posix.join(homedir(), "Library", "Application Support"));
    expect(appDataDir("win32", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" })).toBe("C:\\Users\\dev\\AppData\\Roaming");
    expect(appDataDir("linux", { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg");
    expect(appDataDir("linux", {})).toBe(posix.join(homedir(), ".config"));
  });

  it("ignores relative locations, as the XDG spec and Windows require", () => {
    expect(appDataDir("linux", { XDG_CONFIG_HOME: "relative/dir" })).toBe(posix.join(homedir(), ".config"));
    expect(appDataDir("win32", { APPDATA: "relative" })).toBe(win32.join(homedir(), "AppData", "Roaming"));
  });
});

describe("userLockfilePath", () => {
  it("puts latch.lock in a LatchVerify folder of the app data directory", () => {
    expect(userLockfilePath("win32", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" })).toBe("C:\\Users\\dev\\AppData\\Roaming\\LatchVerify\\latch.lock");
    expect(userLockfilePath("darwin", {})).toBe(posix.join(homedir(), "Library", "Application Support", "LatchVerify", "latch.lock"));
    expect(userLockfilePath("linux", { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/latchverify/latch.lock");
  });

  it("is absolute on every platform", () => {
    expect(win32.isAbsolute(userLockfilePath("win32", {}))).toBe(true);
    expect(posix.isAbsolute(userLockfilePath("linux", {}))).toBe(true);
  });
});
