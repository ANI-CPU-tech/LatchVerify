import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChange, runReview, type ReviewOptions } from "../../src/commands/review.js";
import { analyzeToolList } from "../../src/proxy/analysis.js";
import { LockFileSchema, type LockFile, type McpTool, type PendingChange } from "../../src/schema/index.js";
import { readEvents } from "../../src/store/events.js";
import { applyApproval, findRecord, readLockfile } from "../../src/store/lockfile.js";
import { readPending, reviewOrder, writePending } from "../../src/store/pending.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const example = (): LockFile => LockFileSchema.parse(JSON.parse(readFileSync(join(root, "latch.lock.example"), "utf8")));
const poisoned: McpTool[] = JSON.parse(readFileSync(join(root, "tests/fixtures/poisoned-tools.json"), "utf8")).tools;

/** The rug pull as the proxy queues it: get_forecast, read_config, run_diagnostics, sync_alerts. */
const rugPull = (detectedAt = new Date("2026-10-23T09:00:00.000Z")): PendingChange[] =>
  analyzeToolList("weather", { tools: poisoned }, example(), "2025-06-18", detectedAt)!.changes.map((c) => c.change);

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

let dir: string;
let lockfilePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-review-"));
  lockfilePath = join(dir, "latch.lock");
  await writeFile(lockfilePath, readFileSync(join(root, "latch.lock.example")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run review with captured output. */
async function review(options: Partial<ReviewOptions> = {}) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await runReview({ ui: false, port: 7777, lockfilePath, stateDir: dir, interactive: false, output, ...options });
  return { code, text: strip(text) };
}

describe("reviewOrder", () => {
  it("puts the highest tier first, then the oldest, keeping queue order for ties", () => {
    const [forecast, readConfig, diagnostics, sync] = rugPull();
    const older = { ...readConfig!, tier: 3 as const, detectedAt: "2026-10-22T09:00:00.000Z" };
    const sorted = [readConfig!, sync!, older, forecast!, diagnostics!].sort(reviewOrder);
    expect(sorted.map((c) => [c.toolName, c.tier, c.detectedAt.slice(0, 10)])).toEqual([
      ["read_config", 3, "2026-10-22"],
      ["sync_alerts", 3, "2026-10-23"],
      ["get_forecast", 3, "2026-10-23"],
      ["run_diagnostics", 3, "2026-10-23"],
      ["read_config", 2, "2026-10-23"],
    ]);
  });
});

describe("renderChange", () => {
  it("shows tier, tool, what changed, the capability delta and every finding", () => {
    const forecast = rugPull()[0]!;
    const card = strip(renderChange(forecast, example()));
    expect(card.split("\n").slice(0, 4)).toEqual([
      `tier 3 · hard block  weather/get_forecast  ${forecast.id}`,
      "  detected  2026-10-23T09:00:00.000Z",
      "  changed   description, input schema",
      "  delta     lost network.domains:api.weather.gov",
    ]);
    expect(card).toContain("  findings\n");
    expect(card).toContain('    ✖ critical pattern  Text points the model at a sensitive file (description): "~/.ssh/id_rsa"');
    expect(card).toContain("    ! warn unicode  8 invisible characters in description");
  });

  it("marks a new tool and a tier-2 change without findings", () => {
    const readConfig = rugPull()[1]!;
    const card = strip(renderChange(readConfig, example()));
    expect(card).toContain("tier 2 · blocked for review  weather/read_config");
    expect(card).toContain("  changed   new tool, not in latch.lock");
    expect(card).toContain("  delta     gained filesystem.read; loosened filesystem.scope");
    expect(card).toContain("  findings  none");
  });

  it("notes a change latch.lock already pins", () => {
    const readConfig = rugPull()[1]!;
    const pinned = applyApproval(example(), readConfig, "dev@example.com", new Date());
    expect(strip(renderChange(readConfig, pinned))).toContain("latch.lock already pins this definition");
  });

  it("never prints a server's control characters", () => {
    const change = { ...rugPull()[1]!, toolName: "evil\u001b[2Jname" };
    const card = renderChange(change, example());
    expect(card).not.toContain("\u001b[2J");
    expect(strip(card)).toContain("weather/evil[U+001B][2Jname");
  });
});

describe("runReview without a terminal", () => {
  it("says so when nothing is pending", async () => {
    expect(await review()).toEqual({ code: 0, text: "✔ no pending changes\n" });
  });

  it("lists the queue, tier 3 first with get_forecast leading, and decides nothing", async () => {
    await writePending(dir, rugPull());
    const before = readFileSync(join(dir, "pending.json"), "utf8");
    const { code, text } = await review();
    expect(code).toBe(0);
    expect(text.split("\n")[0]).toBe("latch review: 4 pending changes, highest tier first");
    const headers = text.split("\n").filter((line) => line.startsWith("tier "));
    expect(headers.map((h) => h.split("  ")[1])).toEqual(["weather/get_forecast", "weather/run_diagnostics", "weather/sync_alerts", "weather/read_config"]);
    expect(text).toContain("decide in a terminal with `latch review`, or in the browser with `latch review --ui`");
    expect(readFileSync(join(dir, "pending.json"), "utf8")).toBe(before);
    expect(readFileSync(lockfilePath, "utf8")).toBe(readFileSync(join(root, "latch.lock.example"), "utf8"));
  });

  it("refuses a malformed queue or lockfile", async () => {
    await writeFile(join(dir, "pending.json"), "{ nope");
    await expect(review()).rejects.toThrow("pending.json is not valid JSON");
    await writeFile(lockfilePath, "{ nope");
    await expect(review()).rejects.toThrow();
  });
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";

describe("runReview in a terminal", () => {
  /** One prompt to answer: wait for `when` in the output, run `before`, then type `keys`. */
  interface Step {
    when: string;
    keys: string;
    before?: () => Promise<void>;
  }

  async function decide(steps: Step[], options: Partial<ReviewOptions> = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    let searchFrom = 0;
    let next = 0;
    output.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      const step = steps[next];
      if (step === undefined) return;
      const at = text.indexOf(step.when, searchFrom);
      if (at === -1) return;
      searchFrom = at + step.when.length;
      next++;
      // After the render returns: the prompt starts listening only once it has drawn itself.
      setImmediate(() => void (step.before?.() ?? Promise.resolve()).then(() => input.write(step.keys)));
    });
    const code = await runReview({
      ui: false,
      port: 7777,
      lockfilePath,
      stateDir: dir,
      interactive: true,
      reviewer: "dev@example.com",
      input,
      output,
      ...options,
    });
    expect(next, "every prompt was reached").toBe(steps.length);
    return { code, text: strip(text) };
  }

  const ask = (tool: string) => `◆  Decide on weather/${tool}`;
  const SURE = "◆  This is a hard block";
  const quit = (tool: string): Step => ({ when: ask(tool), keys: `${DOWN}\r` });
  const queueIds = async () => (await readPending(dir)).map((c) => c.toolName);

  beforeEach(async () => {
    await writePending(dir, rugPull());
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("approves the tier-3 get_forecast after confirming, pinning its new hashes (task Verify)", async () => {
    const forecast = rugPull()[0]!;
    const queued = (await readPending(dir))[0]!;
    const { code, text } = await decide([
      { when: ask("get_forecast"), keys: `${UP}${UP}\r` },
      { when: SURE, keys: "y" },
      quit("run_diagnostics"),
    ]);
    expect(code).toBe(0);
    expect(text).toContain("approvals are recorded as dev@example.com");
    expect(text).toContain("✔ approved: latch.lock now pins this definition");
    expect(text).toContain("approved 1, rejected 0, skipped 3");
    expect(text).toContain(`next: commit ${lockfilePath} and open a pull request`);

    const record = findRecord(await readLockfile(lockfilePath), "weather", "get_forecast")!;
    expect(record.hashes).toEqual(forecast.after.hashes);
    expect(record.capabilities).toEqual(forecast.after.capabilities);
    expect(record.approvedBy).toBe("dev@example.com");
    expect(await queueIds()).toEqual(["read_config", "run_diagnostics", "sync_alerts"]);
    expect((await readEvents(dir)).map((e) => e.kind === "approved" && e.changeId)).toEqual([queued.id]);
  });

  it("rejects without touching latch.lock", async () => {
    const lockBefore = readFileSync(lockfilePath, "utf8");
    const { code, text } = await decide([{ when: ask("get_forecast"), keys: `${UP}\r` }, quit("run_diagnostics")]);
    expect(code).toBe(0);
    expect(text).toContain("✔ rejected: the tool stays blocked");
    expect(readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(await queueIds()).toEqual(["read_config", "run_diagnostics", "sync_alerts"]);
    expect((await readEvents(dir)).map((e) => e.kind)).toEqual(["rejected"]);
  });

  it("does not approve a hard block when the confirmation is declined", async () => {
    const lockBefore = readFileSync(lockfilePath, "utf8");
    const { text } = await decide([
      { when: ask("get_forecast"), keys: `${UP}${UP}\r` },
      { when: SURE, keys: "\r" },
      quit("run_diagnostics"),
    ]);
    expect(text).toContain("not approved; left in the queue");
    expect(readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(await queueIds()).toHaveLength(4);
  });

  it("skips every blocked change when Enter is held down", async () => {
    const lockBefore = readFileSync(lockfilePath, "utf8");
    const { code, text } = await decide(["get_forecast", "run_diagnostics", "sync_alerts", "read_config"].map((tool) => ({ when: ask(tool), keys: "\r" })));
    expect(code).toBe(0);
    expect(text).toContain("approved 0, rejected 0, skipped 4");
    expect(readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(await queueIds()).toHaveLength(4);
  });

  it("approves a tier-1 change on Enter, without a confirmation", async () => {
    const readConfig = { ...rugPull()[1]!, tier: 1 as const };
    await writePending(dir, [readConfig]);
    const { code } = await decide([{ when: ask("read_config"), keys: "\r" }]);
    expect(code).toBe(0);
    expect(findRecord(await readLockfile(lockfilePath), "weather", "read_config")?.hashes).toEqual(readConfig.after.hashes);
    expect(await queueIds()).toEqual([]);
  });

  it("stops on Ctrl+C, keeping earlier decisions", async () => {
    const { code, text } = await decide([{ when: ask("get_forecast"), keys: `${UP}\r` }, { when: ask("run_diagnostics"), keys: "\x03" }]);
    expect(code).toBe(0);
    expect(text).toContain("approved 0, rejected 1, skipped 3");
    expect(await queueIds()).toEqual(["read_config", "run_diagnostics", "sync_alerts"]);
  });

  it("does not approve a change that left the queue while it was on screen", async () => {
    const lockBefore = readFileSync(lockfilePath, "utf8");
    const { text } = await decide([
      {
        when: ask("get_forecast"),
        keys: `${UP}${UP}\r`,
        // A running proxy replaces the change with a newer definition meanwhile.
        before: async () => writePending(dir, (await readPending(dir)).map((c) => (c.toolName === "get_forecast" ? { ...c, id: "chg_newer" } : c))),
      },
      { when: SURE, keys: "y" },
      quit("run_diagnostics"),
    ]);
    expect(text).toContain("no longer in the queue");
    expect(readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect((await readPending(dir)).some((c) => c.id === "chg_newer")).toBe(true);
  });

  it("exits 1 when an approval cannot be recorded, leaving the change queued", async () => {
    const foreign = { ...rugPull()[1]!, serverId: "unknown", after: { ...rugPull()[1]!.after, serverId: "unknown" } };
    await writePending(dir, [foreign]);
    const { code, text } = await decide([{ when: "◆  Decide on unknown/read_config", keys: `${UP}${UP}\r` }]);
    expect(code).toBe(1);
    expect(text).toContain('✖ could not record the decision: applyApproval: server "unknown" is not in the lockfile');
    expect(text).toContain("failed 1");
    expect(await readPending(dir)).toEqual([foreign]);
  });

  it("refuses to record approvals without a reviewer", async () => {
    await expect(decide([], { reviewer: "  " })).rejects.toThrow("no reviewer name");
  });
});

describe("runReview --ui", () => {
  let staticDir: string;

  beforeEach(async () => {
    staticDir = join(dir, "web");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>latch review</title>");
    await writePending(dir, rugPull());
    vi.stubEnv("LATCH_REVIEWER", "ui@example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Start review --ui on a free port, run `use` against its URL, then stop it. */
  async function withUi(use: (url: string) => Promise<void>, options: Partial<ReviewOptions> = {}) {
    let stop!: () => void;
    const until = new Promise<void>((resolve) => (stop = resolve));
    let opened: string | undefined;
    let failure: unknown;
    const result = review({
      ui: true,
      port: 0,
      staticDir,
      until,
      openBrowser: (url) => {
        opened = url;
        use(url).catch((error: unknown) => (failure = error)).finally(stop);
      },
      ...options,
    });
    const outcome = await result;
    if (failure !== undefined) throw failure;
    return { ...outcome, opened };
  }

  it("serves the review screen and the queue, opens the browser on it, and stops cleanly (task Verify)", async () => {
    let base = "";
    const { code, text, opened } = await withUi(async (url) => {
      base = url;
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>latch review</title>");
      const pending = (await (await fetch(`${url}/api/pending`)).json()) as PendingChange[];
      expect(pending.map((c) => c.toolName).sort()).toEqual(["get_forecast", "read_config", "run_diagnostics", "sync_alerts"]);
    });
    expect(code).toBe(0);
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(text).toContain(`review UI on ${opened} (approvals are recorded as ui@example.com); press Ctrl+C to stop`);
    expect(text).toContain("review UI stopped");
    await expect(fetch(`${base}/api/pending`)).rejects.toThrow();
  });

  it("approves through the UI into this lockfile and state directory", async () => {
    const forecast = (await readPending(dir))[0]!;
    await withUi(async (url) => {
      const response = await fetch(`${url}/api/pending/${forecast.id}/approve`, { method: "POST", headers: { "X-Latch-Client": "test" } });
      expect(response.status).toBe(200);
    });
    expect(findRecord(await readLockfile(lockfilePath), "weather", "get_forecast")).toMatchObject({
      hashes: forecast.after.hashes,
      approvedBy: "ui@example.com",
    });
    expect((await readPending(dir)).some((c) => c.id === forecast.id)).toBe(false);
  });

  it("records approvals as the reviewer option when one is given", async () => {
    const forecast = (await readPending(dir))[0]!;
    const { text } = await withUi(
      async (url) => {
        await fetch(`${url}/api/pending/${forecast.id}/approve`, { method: "POST", headers: { "X-Latch-Client": "test" } });
      },
      { reviewer: " lead@example.com " },
    );
    expect(text).toContain("approvals are recorded as lead@example.com");
    expect(findRecord(await readLockfile(lockfilePath), "weather", "get_forecast")!.approvedBy).toBe("lead@example.com");
  });

  it("explains how to build the UI when it is missing", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    await expect(review({ ui: true, port: 0, staticDir: empty, until: Promise.resolve() })).rejects.toThrow(
      "latch review --ui: the review UI is not built; run `pnpm exec vite build --config web/vite.config.ts`",
    );
  });

  it("rejects a port that is not a whole number from 0 to 65535", async () => {
    for (const port of [Number.NaN, -1, 65_536, 1.5]) {
      await expect(review({ ui: true, port, staticDir, until: Promise.resolve() }), String(port)).rejects.toThrow("--port must be a whole number");
    }
  });

  it("says when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(review({ ui: true, port, staticDir, until: Promise.resolve(), openBrowser: () => {} })).rejects.toThrow(
        `latch review: port ${port} is in use; choose another with --port`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("refuses to start on a malformed queue", async () => {
    await writeFile(join(dir, "pending.json"), "{ nope");
    await expect(review({ ui: true, port: 0, staticDir, until: Promise.resolve(), openBrowser: () => {} })).rejects.toThrow("not valid JSON");
  });
});
