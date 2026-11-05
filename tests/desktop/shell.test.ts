import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, autostartEntry, autostartPath, loopbackRequest, navigationAllowed, parseFlags, trayMenu, trayTooltip } from "../../src/desktop/shell.js";
import { CLIENT_HEADER, createRoutes } from "../../src/ui/routes.js";

describe("the desktop shell", () => {
  it("reads its flags", () => {
    expect(parseFlags(["electron", "main.js", "--hidden"])).toEqual({ hidden: true, smoke: false, dev: false, uninstall: false });
    expect(parseFlags(["--smoke", "--dev"])).toEqual({ hidden: false, smoke: true, dev: true, uninstall: false });
    expect(parseFlags(["--uninstall"]).uninstall).toBe(true);
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

  it("keeps the window on its own scheme and host, which URL.origin cannot tell apart", () => {
    expect(navigationAllowed(`${APP_ORIGIN}/#/review`, APP_ORIGIN)).toBe(true);
    expect(navigationAllowed("latchverify://other/", APP_ORIGIN)).toBe(false);
    expect(navigationAllowed("evil://app/", APP_ORIGIN)).toBe(false);
    expect(navigationAllowed("http://app/", APP_ORIGIN)).toBe(false);
  });

  it("hands the review API the window's requests as loopback ones, writes included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-shell-"));
    try {
      await copyFile(new URL("../../latch.lock.example", import.meta.url), join(dir, "latch.lock"));
      const app = createRoutes({ lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), settingsPath: join(dir, "settings.json"), reviewer: "t@example.com" });
      const info = await app.fetch(loopbackRequest(new Request(`${APP_ORIGIN}/api/info?x=1`)));
      expect(info.status).toBe(200);
      const put = loopbackRequest(
        new Request(`${APP_ORIGIN}/api/settings`, { method: "PUT", headers: { origin: APP_ORIGIN, "content-type": "application/json", [CLIENT_HEADER]: "app" }, body: JSON.stringify({ notifications: false }) }),
      );
      expect(put.url).toBe("http://127.0.0.1/api/settings");
      expect(put.headers.get("origin")).toBe("http://127.0.0.1");
      const saved = await app.fetch(put);
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as { notifications: boolean }).notifications).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses requests to any other origin", () => {
    expect(() => loopbackRequest(new Request("http://127.0.0.1/api/info"))).toThrow(TypeError);
    expect(() => loopbackRequest(new Request("latchverify://elsewhere/api/info"))).toThrow(TypeError);
  });
});
