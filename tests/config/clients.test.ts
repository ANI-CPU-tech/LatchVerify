import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_CLIENTS, clientConfigPath, type ClientId } from "../../src/config/clients.js";

// os.homedir() follows HOME only on POSIX hosts.
const onWindows = process.platform === "win32";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientConfigPath", () => {
  it.skipIf(onWindows)("uses the documented locations on Linux", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(SUPPORTED_CLIENTS.map((client) => clientConfigPath(client, "linux"))).toEqual([
      "/home/dev/.config/Claude/claude_desktop_config.json",
      "/home/dev/.claude.json",
      "/home/dev/.cursor/mcp.json",
      "/home/dev/.config/Code/User/mcp.json",
    ]);
  });

  it.skipIf(onWindows)("honours an absolute XDG_CONFIG_HOME on Linux and ignores a relative one", () => {
    vi.stubEnv("HOME", "/home/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/data/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/data/config/Claude/claude_desktop_config.json");
    expect(clientConfigPath("vscode", "linux")).toBe("/data/config/Code/User/mcp.json");
    expect(clientConfigPath("cursor", "linux")).toBe("/home/dev/.cursor/mcp.json");
    vi.stubEnv("XDG_CONFIG_HOME", "relative/config");
    expect(clientConfigPath("claude-desktop", "linux")).toBe("/home/dev/.config/Claude/claude_desktop_config.json");
  });

  it.skipIf(onWindows)("uses Application Support on macOS", () => {
    vi.stubEnv("HOME", "/Users/dev");
    vi.stubEnv("XDG_CONFIG_HOME", "/ignored");
    expect(SUPPORTED_CLIENTS.map((client) => clientConfigPath(client, "darwin"))).toEqual([
      "/Users/dev/Library/Application Support/Claude/claude_desktop_config.json",
      "/Users/dev/.claude.json",
      "/Users/dev/.cursor/mcp.json",
      "/Users/dev/Library/Application Support/Code/User/mcp.json",
    ]);
  });

  it.skipIf(onWindows)("uses %APPDATA% and Windows separators on Windows", () => {
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming");
    expect(clientConfigPath("claude-desktop", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(clientConfigPath("vscode", "win32")).toBe("C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\mcp.json");
    expect(clientConfigPath("cursor", "win32").endsWith("\\.cursor\\mcp.json")).toBe(true);
    expect(clientConfigPath("claude-code", "win32").endsWith("\\.claude.json")).toBe(true);
  });

  it.skipIf(onWindows)("falls back to AppData/Roaming under the home directory without %APPDATA%", () => {
    vi.stubEnv("APPDATA", undefined);
    expect(clientConfigPath("claude-desktop", "win32").endsWith("\\AppData\\Roaming\\Claude\\claude_desktop_config.json")).toBe(true);
  });

  it("follows the current platform and home directory by default", () => {
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(clientConfigPath("cursor")).toBe(join(homedir(), ".cursor", "mcp.json"));
    expect(clientConfigPath("claude-code")).toBe(join(homedir(), ".claude.json"));
  });

  it("rejects an unknown client at runtime", () => {
    expect(() => clientConfigPath("zed" as ClientId)).toThrow('unknown MCP client "zed"');
  });
});
