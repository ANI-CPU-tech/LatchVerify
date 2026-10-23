import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_HEADER as SERVER_CLIENT_HEADER, MAX_EVENT_LIMIT, createRoutes } from "../../src/ui/routes.js";
import { appendEvent } from "../../src/store/events.js";
import { writePending } from "../../src/store/pending.js";
import { LockFileSchema, type PendingChange } from "../../src/schema/index.js";

// web/ resolves "@schema/*" through a Vite alias that this (node) test config does not define.
vi.mock("@schema/index.js", () => import("../../src/schema/index.js"));

const {
  ApiError,
  ApiUnreachableError,
  CLIENT_HEADER,
  MAX_EVENTS,
  approveChange,
  fetchEvents,
  fetchLockfile,
  fetchLockfileGit,
  fetchPending,
  rejectChange,
  simulateRugPull,
  toReviewItem,
} = await import(
  "../../web/src/lib/api.js"
);

const lock = LockFileSchema.parse(JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")));
const record = lock.servers.weather!.tools[0]!;
const change: PendingChange = {
  id: "chg_1",
  serverId: "weather",
  toolName: record.name,
  tier: 3,
  detectedAt: "2026-10-23T09:00:00.000Z",
  before: record,
  after: { ...record, hashes: { ...record.hashes, composite: "a".repeat(64) } },
  capabilityDelta: { gained: ["filesystem.read"], lost: [], loosened: ["filesystem.scope"] },
  findings: [{ type: "pattern", severity: "critical", message: "m", evidence: "e" }],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8" } });

/** Replaces fetch for one test and returns the mock to inspect calls. */
const stubFetch = (impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error a promise rejects with. */
const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("CLIENT_HEADER", () => {
  it("matches the header the review API requires", () => {
    expect(CLIENT_HEADER).toBe(SERVER_CLIENT_HEADER);
  });
});

describe("fetchPending", () => {
  it("returns the validated queue as review items without description text", async () => {
    const fetchMock = stubFetch(async () => jsonResponse([change]));
    expect(await fetchPending()).toEqual([{ change, descriptionBefore: null, descriptionAfter: null, descriptionDiff: null }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/pending", expect.objectContaining({ headers: { Accept: "application/json" } }));
  });

  it("rejects a reply that does not match the schema instead of rendering it", async () => {
    stubFetch(async () => jsonResponse([{ ...change, tier: 7 }]));
    const error = await failure(fetchPending());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toContain("invalid queue");
  });

  it("reports malformed JSON as an API error", async () => {
    stubFetch(async () => new Response("[{", { status: 200, headers: { "content-type": "application/json" } }));
    expect((await failure(fetchPending())) as Error).toMatchObject({ name: "ApiError", message: "The review API sent malformed JSON" });
  });

  it("treats network failures, gateway errors and non-JSON answers as unreachable", async () => {
    const replies: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("", { status: 502, headers: { "content-type": "text/plain" } }),
      async () => new Response("", { status: 503 }),
      async () => new Response("", { status: 504 }),
      async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      async () => new Response("oops", { status: 500, headers: { "content-type": "text/plain" } }),
    ];
    for (const reply of replies) {
      stubFetch(reply);
      expect(await failure(fetchPending())).toBeInstanceOf(ApiUnreachableError);
    }
  });

  it("surfaces the API's own error message and status", async () => {
    stubFetch(async () => jsonResponse({ error: "/x/.latch/pending.json is not valid JSON" }, 500));
    expect(await failure(fetchPending())).toMatchObject({ name: "ApiError", status: 500, message: "/x/.latch/pending.json is not valid JSON" });
  });

  it("rethrows aborts instead of calling the API unreachable", async () => {
    const controller = new AbortController();
    stubFetch(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return jsonResponse([]);
    });
    controller.abort();
    const error = await failure(fetchPending(controller.signal));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("approveChange and rejectChange", () => {
  it("POST to the change's endpoint with the client header and an encoded id", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(record));
    await approveChange("chg/1 ?x");
    expect(fetchMock).toHaveBeenCalledWith("/api/pending/chg%2F1%20%3Fx/approve", {
      method: "POST",
      headers: { Accept: "application/json", [SERVER_CLIENT_HEADER]: "review-ui" },
    });

    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await rejectChange("chg_1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/pending/chg_1/reject", expect.objectContaining({ method: "POST" }));
  });

  it("throw the API's message for refused or conflicting changes", async () => {
    stubFetch(async () => jsonResponse({ error: 'server "mail" is not in the lockfile' }, 409));
    expect(await failure(approveChange("chg_1"))).toMatchObject({ name: "ApiError", status: 409, message: 'server "mail" is not in the lockfile' });
    stubFetch(async () => jsonResponse({ error: 'no pending change "x"' }, 404));
    expect(await failure(rejectChange("x"))).toMatchObject({ status: 404 });
  });

  it("fall back to the status when the error body has no message", async () => {
    stubFetch(async () => jsonResponse({ nope: true }, 403));
    expect(await failure(approveChange("chg_1"))).toMatchObject({ name: "ApiError", message: "HTTP 403" });
  });
});

describe("toReviewItem", () => {
  it("wraps a pending change with no description text", () => {
    expect(toReviewItem(change)).toEqual({ change, descriptionBefore: null, descriptionAfter: null, descriptionDiff: null });
  });
});

describe("fetchEvents, fetchLockfile, fetchLockfileGit", () => {
  it("ask for the most events the API allows by default", async () => {
    expect(MAX_EVENTS).toBe(MAX_EVENT_LIMIT);
    const fetchMock = stubFetch(async () => jsonResponse([]));
    await fetchEvents();
    expect(fetchMock).toHaveBeenCalledWith(`/api/events?limit=${MAX_EVENT_LIMIT}`, expect.anything());
  });

  it("reject replies that do not match their schema", async () => {
    stubFetch(async () => jsonResponse([{ kind: "approved", at: "yesterday" }]));
    expect(((await failure(fetchEvents())) as Error).message).toContain("invalid event log");
    stubFetch(async () => jsonResponse({ version: "1" }));
    expect(((await failure(fetchLockfile())) as Error).message).toContain("invalid lockfile");
    stubFetch(async () => jsonResponse({ available: true }));
    expect(((await failure(fetchLockfileGit())) as Error).message).toContain("invalid git status");
  });

  it("read what the real review API serves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-web-api-"));
    try {
      const deps = { lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), reviewer: "alice@example.com" };
      await copyFile(new URL("../../latch.lock.example", import.meta.url), deps.lockfilePath);
      await writePending(deps.stateDir, [change]);
      await appendEvent(deps.stateDir, { kind: "tools_listed", at: "2026-10-23T09:00:00.000Z", serverId: "weather", toolCount: 2 });
      const app = createRoutes(deps);
      stubFetch(async (input, init) => app.request(String(input), init));

      expect(await fetchLockfile()).toEqual(lock);
      expect(await fetchEvents()).toEqual([{ kind: "tools_listed", at: "2026-10-23T09:00:00.000Z", serverId: "weather", toolCount: 2 }]);
      expect((await fetchPending()).map((item) => item.change)).toEqual([change]);
      expect(await fetchLockfileGit()).toMatchObject({ available: expect.any(Boolean) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("simulateRugPull", () => {
  const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
  const request = { serverId: "weather", pinned: fixture("benign-tools.json"), served: fixture("poisoned-tools.json"), callsBefore: ["get_alerts"], callsAfter: ["get_forecast"] };

  it("posts with the client header and returns the validated result from the real API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-api-sim-"));
    try {
      const app = createRoutes({ lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), reviewer: "alice@example.com" });
      const mock = stubFetch(async (input, init) => app.request(`http://127.0.0.1${String(input)}`, init));
      const result = await simulateRugPull(request);
      expect(mock.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { [CLIENT_HEADER]: "review-ui" } });
      expect(result.callsBefore).toEqual([{ toolName: "get_alerts", blocked: null }]);
      expect(result.callsAfter[0]!.blocked?.error.code).toBe(-32001);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a reply that is not a simulation result", async () => {
    stubFetch(async () => jsonResponse({ serverId: "weather" }));
    expect(await failure(simulateRugPull(request))).toMatchObject({ name: "ApiError" });
  });
});
