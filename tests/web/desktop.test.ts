import { afterEach, describe, expect, it } from "vitest";
import { checkSummary, inDesktopApp, updateStatus } from "../../web/src/lib/desktop.js";

afterEach(() => {
  delete (globalThis as { latch?: unknown }).latch;
});

describe("the desktop bridge", () => {
  it("is absent in a browser, and its calls say they need the app", async () => {
    expect(inDesktopApp()).toBe(false);
    await expect(updateStatus()).rejects.toThrow("needs the LatchVerify app");
  });

  it("validates what the app answers", async () => {
    const answer: unknown = { current: "0.2.0", installed: true, busy: false };
    (globalThis as { latch?: unknown }).latch = { updateStatus: async () => answer, checkForUpdates: async () => ({}), installUpdate: async () => ({}), uninstall: async () => ({}) };
    expect(inDesktopApp()).toBe(true);
    expect(await updateStatus()).toEqual(answer);
    (globalThis as unknown as { latch: { updateStatus: () => Promise<unknown> } }).latch.updateStatus = async () => ({ current: 1 });
    await expect(updateStatus()).rejects.toThrow();
  });

  it("sums up a check", () => {
    expect(checkSummary({ available: true, version: "0.3.0" }, "0.2.0")).toBe("LatchVerify 0.3.0 is available.");
    expect(checkSummary({ available: false }, "0.2.0")).toBe("LatchVerify 0.2.0 is the latest release.");
    expect(checkSummary({ available: false, error: "HTTP 404" }, "0.2.0")).toBe("Could not check for updates: HTTP 404.");
  });
});
