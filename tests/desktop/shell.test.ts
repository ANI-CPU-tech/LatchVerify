import { describe, expect, it } from "vitest";
import { autostartEntry, autostartPath, navigationAllowed, parseFlags, trayMenu, trayTooltip } from "../../src/desktop/shell.js";

describe("the desktop shell", () => {
  it("reads its flags", () => {
    expect(parseFlags(["electron", "main.js", "--hidden"])).toEqual({ hidden: true, smoke: false, dev: false });
    expect(parseFlags(["--smoke", "--dev"])).toEqual({ hidden: false, smoke: true, dev: true });
  });

  it("lets the window load only its own review server", () => {
    const base = "http://127.0.0.1:43210";
    expect(navigationAllowed("http://127.0.0.1:43210/#/review", base)).toBe(true);
    expect(navigationAllowed("http://127.0.0.1:43211/", base)).toBe(false);
    expect(navigationAllowed("https://evil.example/", base)).toBe(false);
    expect(navigationAllowed("not a url", base)).toBe(false);
  });

  it("builds the tray menu and tooltip from the state", () => {
    const menu = trayMenu({ pending: 2, paused: false, updateLabel: "Check for updates" });
    expect(menu.map((item) => ("separator" in item ? "-" : item.label))).toEqual([
      "Open LatchVerify",
      "Review queue (2)",
      "-",
      "Pause watching MCP clients",
      "Check for updates",
      "-",
      "Quit LatchVerify",
    ]);
    expect(trayMenu({ pending: 0, paused: true, updateLabel: "x" })[1]).toEqual({ id: "review", label: "Review queue (empty)", enabled: false });
    expect(trayTooltip({ pending: 1, paused: false })).toBe("LatchVerify: 1 change waits for review");
    expect(trayTooltip({ pending: 0, paused: true })).toBe("LatchVerify: paused");
  });

  it("writes an XDG autostart entry that starts the app hidden, with its path quoted", () => {
    expect(autostartPath("/home/me", {})).toBe("/home/me/.config/autostart/latchverify.desktop");
    expect(autostartPath("/home/me", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/autostart/latchverify.desktop");
    const entry = autostartEntry('/opt/Latch Verify/latch"verify');
    expect(entry).toContain('Exec="/opt/Latch Verify/latch\\"verify" --hidden\n');
    expect(entry.startsWith("[Desktop Entry]\nType=Application\n")).toBe(true);
  });
});
