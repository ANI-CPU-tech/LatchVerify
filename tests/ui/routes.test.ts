import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, createRoutes, type RouteDeps } from "../../src/ui/routes.js";
import { appendEvent, type LatchEvent } from "../../src/store/events.js";
import { readLockfile } from "../../src/store/lockfile.js";
import { writePending } from "../../src/store/pending.js";
import type { PendingChange, ToolRecord } from "../../src/schema/index.js";

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
  const lock = await readLockfile(EXAMPLE_LOCK.pathname);
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
const request = (path: string, init?: RequestInit) => createRoutes(deps).request(path, init);

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
    expect(await json(await request("/api/lockfile"))).toEqual(await readLockfile(EXAMPLE_LOCK.pathname));
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
