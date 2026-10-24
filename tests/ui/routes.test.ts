import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_HEADER, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, MAX_SIMULATION_BYTES, createRoutes, type RouteDeps } from "../../src/ui/routes.js";
import { EVENTS_FILE, appendEvent, readEvents, type LatchEvent } from "../../src/store/events.js";
import { findRecord, readLockfile } from "../../src/store/lockfile.js";
import { readPending, writePending } from "../../src/store/pending.js";
import { SimulationResultSchema, type PendingChange, type ToolRecord } from "../../src/schema/index.js";

const EXAMPLE_LOCK = new URL("../../latch.lock.example", import.meta.url);
const HASH = "d".repeat(64);
const NOW = new Date("2026-10-23T10:00:00.000Z");

let dir: string;
let deps: RouteDeps;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-ui-"));
  deps = { lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), reviewer: "alice@example.com", now: () => NOW };
  await copyFile(EXAMPLE_LOCK, deps.lockfilePath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The example lockfile's record for a weather tool, or undefined when it is not pinned. */
const pinned = async (name: string): Promise<ToolRecord | undefined> => {
  const lock = await readLockfile(fileURLToPath(EXAMPLE_LOCK));
  return structuredClone(lock.servers.weather!.tools.find((t) => t.name === name));
};

/**
 * A pending change to weather/<toolName>: the pinned record with new description hashes, or,
 * for a tool that is not pinned, a copy of get_forecast's record renamed to `toolName`.
 */
const pendingChange = async (id: string, toolName: string, tier: PendingChange["tier"], detectedAt: string): Promise<PendingChange> => {
  const before = await pinned(toolName);
  const base = before ?? (await pinned("get_forecast"))!;
  const after: ToolRecord = { ...structuredClone(base), name: toolName, hashes: { ...base.hashes, description: HASH, composite: HASH } };
  return { id, serverId: "weather", toolName, tier, detectedAt, before: before ?? null, after, capabilityDelta: { gained: [], lost: [], loosened: [] }, findings: [] };
};

/** Sends a request to a fresh app built from `deps`. */
const request = async (path: string, init?: RequestInit): Promise<Response> => createRoutes(deps).request(path, init);

const json = async (response: Response): Promise<unknown> => response.json();

describe("GET /api/pending", () => {
  it("returns an empty queue when nothing is pending", async () => {
    const response = await request("/api/pending");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await json(response)).toEqual([]);
  });

  it("returns the queue sorted by tier, highest first, then oldest first", async () => {
    const queue = [
      await pendingChange("c_t0", "get_alerts", 0, "2026-10-23T09:00:00.000Z"),
      await pendingChange("c_t3_late", "get_forecast", 3, "2026-10-23T09:30:00.000Z"),
      await pendingChange("c_t2", "new_tool", 2, "2026-10-23T08:00:00.000Z"),
      // Second-precision timestamp: ordering compares instants, not strings.
      await pendingChange("c_t3_early", "other_tool", 3, "2026-10-23T09:10:00Z"),
    ];
    await writePending(deps.stateDir, queue);
    const ids = ((await json(await request("/api/pending"))) as PendingChange[]).map((c) => c.id);
    expect(ids).toEqual(["c_t3_early", "c_t3_late", "c_t2", "c_t0"]);
  });

  it("keeps queue order for ties, the same order `latch review` walks", async () => {
    const at = "2026-10-23T09:00:00.000Z";
    await writePending(deps.stateDir, [await pendingChange("c_b", "get_forecast", 3, at), await pendingChange("c_a", "get_alerts", 3, at)]);
    const ids = ((await json(await request("/api/pending"))) as PendingChange[]).map((c) => c.id);
    expect(ids).toEqual(["c_b", "c_a"]);
  });

  it("reports a damaged queue as a 500 instead of an empty list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mkdir(deps.stateDir, { recursive: true });
    await writeFile(join(deps.stateDir, "pending.json"), "{ not json");
    const response = await request("/api/pending");
    expect(response.status).toBe(500);
    expect(((await json(response)) as { error: string }).error).toContain("not valid JSON");
  });
});

describe("GET /api/pending/:id", () => {
  it("returns one change by id", async () => {
    const change = await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z");
    await writePending(deps.stateDir, [change]);
    const response = await request("/api/pending/chg_1");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(change);
  });

  it("returns 404 with a JSON error for an unknown id", async () => {
    const response = await request("/api/pending/nope");
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: 'no pending change "nope"' });
  });
});

describe("GET /api/events", () => {
  const event = (i: number): LatchEvent => ({ kind: "list_changed", at: new Date(Date.UTC(2026, 9, 23, 0, 0, i)).toISOString(), serverId: `s${i}` });

  it(`returns the newest ${DEFAULT_EVENT_LIMIT} events, oldest first, by default`, async () => {
    for (let i = 0; i < DEFAULT_EVENT_LIMIT + 5; i++) await appendEvent(deps.stateDir, event(i));
    const events = (await json(await request("/api/events"))) as LatchEvent[];
    expect(events).toHaveLength(DEFAULT_EVENT_LIMIT);
    expect(events[0]).toEqual(event(5));
    expect(events.at(-1)).toEqual(event(DEFAULT_EVENT_LIMIT + 4));
  });

  it("honours ?limit=", async () => {
    for (let i = 0; i < 3; i++) await appendEvent(deps.stateDir, event(i));
    expect(await json(await request("/api/events?limit=2"))).toEqual([event(1), event(2)]);
    expect(await json(await request("/api/events?limit=0"))).toEqual([]);
  });

  it("rejects a malformed or excessive limit with 400", async () => {
    for (const limit of ["-1", "abc", "1.5", "", String(MAX_EVENT_LIMIT + 1), "1e3"]) {
      const response = await request(`/api/events?limit=${encodeURIComponent(limit)}`);
      expect(response.status).toBe(400);
      expect(((await json(response)) as { error: string }).error).toContain("limit must be a whole number");
    }
  });

  it("returns an empty log when nothing has happened", async () => {
    expect(await json(await request("/api/events"))).toEqual([]);
  });
});

describe("GET /api/lockfile", () => {
  it("returns the approved state", async () => {
    expect(await json(await request("/api/lockfile"))).toEqual(await readLockfile(fileURLToPath(EXAMPLE_LOCK)));
  });

  it("reports an invalid lockfile as a 500 naming the file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(deps.lockfilePath, JSON.stringify({ version: "9", generatedAt: NOW.toISOString(), servers: {} }));
    const response = await request("/api/lockfile");
    expect(response.status).toBe(500);
    expect(((await json(response)) as { error: string }).error).toContain(deps.lockfilePath);
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const response = await request("/api/nothing-here");
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "no route for GET /api/nothing-here" });
  });
});

/** POSTs to a fresh app built from `deps`. */
const post = async (path: string, app = createRoutes(deps)): Promise<Response> =>
  app.request(path, { method: "POST", headers: { [CLIENT_HEADER]: "review-ui" } });

describe("createRoutes", () => {
  it("requires a reviewer, since approvals record who made them", () => {
    expect(() => createRoutes({ ...deps, reviewer: "  " })).toThrow(TypeError);
  });
});

describe("POST /api/pending/:id/approve", () => {
  it("pins the change in latch.lock, dequeues it, logs it and returns the new record", async () => {
    const change = await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z");
    const other = await pendingChange("chg_2", "get_alerts", 2, "2026-10-23T09:05:00.000Z");
    await writePending(deps.stateDir, [change, other]);

    const response = await post("/api/pending/chg_1/approve");
    expect(response.status).toBe(200);
    const record = (await json(response)) as ToolRecord;
    expect(record).toMatchObject({ name: "get_forecast", approvedBy: "alice@example.com", approvedAt: NOW.toISOString() });
    expect(record.hashes.composite).toBe(HASH);

    const lock = await readLockfile(deps.lockfilePath);
    expect(findRecord(lock, "weather", "get_forecast")).toEqual(record);
    expect(findRecord(lock, "weather", "get_alerts")).toEqual(await pinned("get_alerts"));
    expect(lock.generatedAt).toBe(NOW.toISOString());
    expect((await readPending(deps.stateDir)).map((c) => c.id)).toEqual(["chg_2"]);
    expect(await readEvents(deps.stateDir)).toEqual([
      { kind: "approved", at: NOW.toISOString(), serverId: "weather", toolName: "get_forecast", changeId: "chg_1", approvedBy: "alice@example.com" },
    ]);
  });

  it("records the reviewer without surrounding whitespace", async () => {
    deps.reviewer = "  bob@example.com\n";
    await writePending(deps.stateDir, [await pendingChange("chg_1", "get_forecast", 2, "2026-10-23T09:00:00.000Z")]);
    expect(((await json(await post("/api/pending/chg_1/approve"))) as ToolRecord).approvedBy).toBe("bob@example.com");
  });

  it("adds a tool that was not pinned before", async () => {
    await writePending(deps.stateDir, [await pendingChange("chg_new", "new_tool", 2, "2026-10-23T09:00:00.000Z")]);
    expect((await post("/api/pending/chg_new/approve")).status).toBe(200);
    expect((await readLockfile(deps.lockfilePath)).servers.weather!.tools.map((t) => t.name)).toEqual(["get_alerts", "get_forecast", "new_tool"]);
  });

  it("returns 404 for an unknown change and leaves latch.lock untouched", async () => {
    const before = await readFile(deps.lockfilePath, "utf8");
    const response = await post("/api/pending/nope/approve");
    expect(response.status).toBe(404);
    expect(await readFile(deps.lockfilePath, "utf8")).toBe(before);
  });

  it("returns 409 for a change that cannot be recorded, changing nothing", async () => {
    const change = await pendingChange("chg_mail", "send_email", 2, "2026-10-23T09:00:00.000Z");
    const foreign: PendingChange = { ...change, serverId: "mail", after: { ...change.after, serverId: "mail" } };
    await writePending(deps.stateDir, [foreign]);
    const before = await readFile(deps.lockfilePath, "utf8");
    const response = await post("/api/pending/chg_mail/approve");
    expect(response.status).toBe(409);
    expect(((await json(response)) as { error: string }).error).toContain('server "mail" is not in the lockfile');
    expect(await readFile(deps.lockfilePath, "utf8")).toBe(before);
    expect(await readPending(deps.stateDir)).toEqual([foreign]);
  });

  it("returns 500 and keeps the change queued when latch.lock is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const change = await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z");
    await writePending(deps.stateDir, [change]);
    await writeFile(deps.lockfilePath, "{ broken");
    expect((await post("/api/pending/chg_1/approve")).status).toBe(500);
    expect(await readPending(deps.stateDir)).toEqual([change]);
  });

  it("serializes concurrent approvals so neither is lost", async () => {
    const changes = [
      await pendingChange("chg_a", "get_forecast", 3, "2026-10-23T09:00:00.000Z"),
      await pendingChange("chg_b", "new_tool", 2, "2026-10-23T09:01:00.000Z"),
      await pendingChange("chg_c", "get_alerts", 2, "2026-10-23T09:02:00.000Z"),
    ];
    await writePending(deps.stateDir, changes);
    const app = createRoutes(deps);
    const statuses = await Promise.all(changes.map((c) => post(`/api/pending/${c.id}/approve`, app).then((r) => r.status)));
    expect(statuses).toEqual([200, 200, 200]);
    const lock = await readLockfile(deps.lockfilePath);
    for (const name of ["get_forecast", "new_tool", "get_alerts"]) expect(findRecord(lock, "weather", name)?.hashes.composite).toBe(HASH);
    expect(await readPending(deps.stateDir)).toEqual([]);
  });

  it("approves a change only once when the same request races", async () => {
    await writePending(deps.stateDir, [await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z")]);
    const app = createRoutes(deps);
    const statuses = await Promise.all([post("/api/pending/chg_1/approve", app), post("/api/pending/chg_1/approve", app)].map((p) => p.then((r) => r.status)));
    expect(statuses.sort()).toEqual([200, 404]);
    expect(await readEvents(deps.stateDir)).toHaveLength(1);
  });

  it("still succeeds when the event log cannot be written", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await writePending(deps.stateDir, [await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z")]);
    await mkdir(join(deps.stateDir, EVENTS_FILE)); // a directory where the log file should be
    expect((await post("/api/pending/chg_1/approve")).status).toBe(200);
    expect(findRecord(await readLockfile(deps.lockfilePath), "weather", "get_forecast")?.hashes.composite).toBe(HASH);
    expect(logged).toHaveBeenCalled();
  });
});

describe("POST /api/pending/:id/reject", () => {
  it("dequeues the change, logs it, leaves latch.lock untouched and returns 204", async () => {
    const change = await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z");
    await writePending(deps.stateDir, [change]);
    const before = await readFile(deps.lockfilePath, "utf8");

    const response = await post("/api/pending/chg_1/reject");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await readFile(deps.lockfilePath, "utf8")).toBe(before);
    expect(await readPending(deps.stateDir)).toEqual([]);
    expect(await readEvents(deps.stateDir)).toEqual([
      { kind: "rejected", at: NOW.toISOString(), serverId: "weather", toolName: "get_forecast", changeId: "chg_1" },
    ]);
  });

  it("returns 404 for an unknown change", async () => {
    expect((await post("/api/pending/nope/reject")).status).toBe(404);
  });
});

describe("request guard", () => {
  beforeEach(async () => {
    await writePending(deps.stateDir, [await pendingChange("chg_1", "get_forecast", 3, "2026-10-23T09:00:00.000Z")]);
  });

  const approve = async (init: RequestInit = {}, url = "/api/pending/chg_1/approve"): Promise<Response> =>
    createRoutes(deps).request(url, { method: "POST", ...init });

  it(`refuses writes without the ${CLIENT_HEADER} header, so a cross-site form cannot approve`, async () => {
    const response = await approve({ headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: `missing ${CLIENT_HEADER} header` });
    expect(await readPending(deps.stateDir)).toHaveLength(1);
  });

  it("refuses writes from a foreign or opaque origin even with the header", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example:7777", "null"]) {
      const response = await approve({ headers: { origin, [CLIENT_HEADER]: "x" } });
      expect(response.status).toBe(403);
    }
    expect(await readPending(deps.stateDir)).toHaveLength(1);
  });

  it("accepts writes from loopback origins, including the Vite dev server", async () => {
    const response = await approve({ headers: { origin: "http://localhost:5173", [CLIENT_HEADER]: "review-ui" } });
    expect(response.status).toBe(200);
  });

  it("refuses any request addressed to a non-loopback host (DNS rebinding)", async () => {
    for (const url of ["http://evil.example/api/pending", "http://192.168.1.5:7777/api/pending", "http://localhost.evil.example/api/lockfile"]) {
      const response = await createRoutes(deps).request(url);
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: "the review API only answers on localhost" });
    }
    expect((await createRoutes(deps).request("http://127.0.0.1:7777/api/pending")).status).toBe(200);
    expect((await createRoutes(deps).request("http://[::1]:7777/api/pending")).status).toBe(200);
  });

  it("lets reads through without the header", async () => {
    expect((await request("/api/pending")).status).toBe(200);
  });

  it("marks responses, including errors, as uncacheable and not sniffable", async () => {
    for (const response of [await request("/api/pending"), await request("/api/pending/nope")]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("POST /api/simulate", () => {
  const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
  const body = () => ({ serverId: "weather", pinned: fixture("benign-tools.json"), served: fixture("poisoned-tools.json"), callsBefore: ["get_alerts"], callsAfter: ["get_forecast"] });
  const post = (payload: unknown, headers: Record<string, string> = { [CLIENT_HEADER]: "test" }) =>
    request("http://127.0.0.1/api/simulate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });

  it("runs the rug pull and writes nothing", async () => {
    const lockBefore = await readFile(deps.lockfilePath, "utf8");
    const response = await post(body());
    expect(response.status).toBe(200);
    const result = SimulationResultSchema.parse(await json(response));
    expect(result.callsAfter[0]!.blocked?.error.code).toBe(-32001);
    expect(await readFile(deps.lockfilePath, "utf8")).toBe(lockBefore);
    expect(await readPending(deps.stateDir)).toEqual([]);
    expect(await readEvents(deps.stateDir, MAX_EVENT_LIMIT)).toEqual([]);
  });

  it("needs the client header, like every write", async () => {
    expect((await post(body(), {})).status).toBe(403);
  });

  it("answers 400 for a body that is not a simulation", async () => {
    expect((await post({ serverId: "weather" })).status).toBe(400);
    expect((await post({ ...body(), pinned: 42 })).status).toBe(400);
    const notJson = await request("http://127.0.0.1/api/simulate", { method: "POST", headers: { [CLIENT_HEADER]: "test" }, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("answers 413 for a body over the limit", async () => {
    const response = await post({ ...body(), served: { tools: [], padding: "x".repeat(MAX_SIMULATION_BYTES) } });
    expect(response.status).toBe(413);
  });
});
