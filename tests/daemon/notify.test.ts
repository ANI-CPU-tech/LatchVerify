import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_ID, callsBlocked, changeQueued, desktopNotifier, notifySendArgs, pendingSummary, toastXml } from "../../src/daemon/notify.js";
import type { PendingChange, ToolRecord } from "../../src/schema/index.js";

const record = (name: string): ToolRecord => ({
  name,
  serverId: "weather",
  hashes: { name: "a".repeat(64), description: "b".repeat(64), inputSchema: "c".repeat(64), metadata: "d".repeat(64), composite: "e".repeat(64) },
  capabilities: {
    filesystem: { read: false, write: false, scope: "none", paths: [] },
    exec: { enabled: false, shell: false },
    network: { egress: true, domains: [], unconstrained: false },
    credentials: { readsEnv: false, readsSecrets: false },
    crossServerRefs: [],
    declared: {},
  },
  approvedBy: "dev@example.com",
  approvedAt: "2026-10-29T09:00:00.000Z",
  specVersion: "2025-06-18",
});

const change = (toolName: string, tier: PendingChange["tier"], extra: Partial<PendingChange> = {}): PendingChange => ({
  id: `chg_${toolName}`,
  serverId: "weather",
  toolName,
  tier,
  detectedAt: "2026-10-29T09:00:00.000Z",
  before: record(toolName),
  after: record(toolName),
  capabilityDelta: { gained: ["filesystem.read"], lost: [], loosened: [] },
  findings: tier === 3 ? [{ type: "pattern", severity: "critical", message: "hidden instructions in the description", evidence: "<IMPORTANT>" }] : [],
  ...extra,
});

describe("pendingSummary", () => {
  it("is nothing for an empty queue", () => {
    expect(pendingSummary([])).toBeUndefined();
  });

  it("counts the changes, names the riskiest first and is critical when one is high risk", () => {
    expect(pendingSummary([change("get_alerts", 2), change("get_forecast", 3)])).toEqual({
      title: "2 tool changes wait for your review",
      body: "1 is high risk. weather/get_forecast, weather/get_alerts. Their calls are blocked until you approve or reject them.",
      urgency: "critical",
    });
    expect(pendingSummary([change("get_alerts", 2)])).toMatchObject({ title: "1 tool change waits for your review", urgency: "normal" });
  });

  it("names three tools and counts the rest", () => {
    const queue = ["a", "b", "c", "d", "e"].map((name) => change(name, 2));
    expect(pendingSummary(queue)!.body).toBe("weather/a, weather/b, weather/c and 2 more. Their calls are blocked until you approve or reject them.");
  });
});

describe("changeQueued", () => {
  it("says what changed", () => {
    expect(changeQueued(change("get_forecast", 3))).toEqual({
      title: "High risk: weather/get_forecast changed",
      body: "hidden instructions in the description. Its calls are blocked until you review it in LatchVerify.",
      urgency: "critical",
    });
    expect(changeQueued(change("get_alerts", 2)).body).toBe("gained filesystem.read. Its calls are blocked until you review it in LatchVerify.");
    expect(changeQueued(change("new_tool", 2, { before: null })).body).toBe("a new tool. Its calls are blocked until you review it in LatchVerify.");
  });

  it("shows server-controlled names safely and cut to length", () => {
    const sneaky = changeQueued(change("get‮forecast\x1b[31m" + "x".repeat(200), 2));
    expect(sneaky.title).toContain("get[U+202E]forecast[U+001B][31m");
    expect(sneaky.title.length).toBeLessThanOrEqual(80);
    expect(sneaky.title.endsWith("…")).toBe(true);
  });
});

describe("callsBlocked", () => {
  const blocked = (reason: string) => ({ kind: "call_blocked" as const, at: "2026-10-29T09:00:00.000Z", serverId: "weather", toolName: "get_forecast", reason });

  it("says why, and counts repeated calls", () => {
    expect(callsBlocked(blocked("hard_block chg_1"))).toEqual({
      title: "Blocked weather/get_forecast",
      body: "The AI client's call was stopped: it changed in a high-risk way and waits for review.",
      urgency: "critical",
    });
    expect(callsBlocked(blocked("pending_review chg_2"), 4)).toMatchObject({ title: "Blocked weather/get_forecast (4 calls)", urgency: "normal" });
    expect(callsBlocked(blocked("server_unpinned")).body).toBe("The AI client's call was stopped: its server is not pinned in latch.lock yet.");
    expect(callsBlocked(blocked("something new")).body).toBe("The AI client's call was stopped: LatchVerify could not check it.");
  });
});

describe("desktop backends", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("gives notify-send the app name, icon, desktop entry and urgency, then the text after --", () => {
    expect(notifySendArgs({ title: "-t", body: "b", urgency: "critical" }, "/icon.svg")).toEqual([
      "--app-name=LatchVerify",
      "--icon=/icon.svg",
      `--hint=string:desktop-entry:${APP_ID}`,
      "--urgency=critical",
      "--",
      "-t",
      "b",
    ]);
  });

  it("escapes the toast text", () => {
    const xml = toastXml({ title: "<b>&'\"", body: "x", urgency: "normal" });
    expect(xml).toContain("<text>&#60;b&#62;&#38;&#39;&#34;</text>");
    expect(xml).toContain('<audio silent="false"/>');
    expect(toastXml({ title: "t", body: "b", urgency: "critical" })).toContain("Notification.Reminder");
  });

  it("is off where the desktop has no notifier", () => {
    expect(desktopNotifier("linux", { PATH: "" })).toBeUndefined();
    expect(desktopNotifier("darwin", {})).toBeUndefined();
    expect(desktopNotifier("win32", {})).toBeTypeOf("function");
  });

  it.skipIf(process.platform === "win32")("runs notify-send from PATH with the notification", async () => {
    dir = await mkdtemp(join(tmpdir(), "latch-notify-"));
    const out = join(dir, "args.txt");
    await writeFile(join(dir, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
    await chmod(join(dir, "notify-send"), 0o755);
    const notify = desktopNotifier("linux", { PATH: dir })!;
    await notify({ title: "Blocked weather/get_forecast", body: "why", urgency: "normal" });
    const args = (await readFile(out, "utf8")).trim().split("\n");
    expect(args.slice(-3)).toEqual(["--", "Blocked weather/get_forecast", "why"]);
    expect(args[1]).toMatch(/^--icon=.*favicon\.svg$/);
  });
});
