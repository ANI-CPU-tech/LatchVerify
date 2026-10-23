import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { PendingChange } from "../schema/index.js";
import { readEvents } from "../store/events.js";
import { readLockfile } from "../store/lockfile.js";
import { readPending } from "../store/pending.js";

/** Filesystem locations the review API reads and writes. */
export interface RouteDeps {
  lockfilePath: string;
  stateDir: string;
  /** Identity recorded as approvedBy, e.g. the git user.email. */
  reviewer: string;
  /** Clock for approval and event timestamps. Defaults to the system clock. */
  now?: () => Date;
}

/** Events returned by GET /api/events when no limit is given, and the most it will return. */
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1_000;

/** An error with the HTTP status the client should see. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

/** Highest tier first, then oldest first, then by id so the order is fully determined. */
function reviewOrder(a: PendingChange, b: PendingChange): number {
  return b.tier - a.tier || Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Parses ?limit= for the event log: a whole number from 0 to MAX_EVENT_LIMIT. */
function eventLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVENT_LIMIT;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) > MAX_EVENT_LIMIT) {
    throw new ApiError(400, `limit must be a whole number from 0 to ${MAX_EVENT_LIMIT}`);
  }
  return Number(raw);
}

/**
 * Review API consumed by web/src/lib/api.ts. Every response is JSON; errors are
 * `{ "error": message }` with a 4xx status for client mistakes and 500 otherwise.
 */
export function createRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  // The review queue, highest tier first, oldest first within a tier. Returns PendingChange[].
  app.get("/api/pending", async (c) => c.json((await readPending(deps.stateDir)).sort(reviewOrder)));

  // One pending change by id, or 404.
  app.get("/api/pending/:id", async (c) => {
    const id = c.req.param("id");
    const change = (await readPending(deps.stateDir)).find((entry) => entry.id === id);
    if (!change) throw new ApiError(404, `no pending change "${id}"`);
    return c.json(change);
  });

  // TODO: applyApproval(lockfile, change, deps.reviewer) → writeLockfile → dequeue → appendEvent("approved").
  // Returns the updated ToolRecord. The user still commits latch.lock and opens a PR.
  app.post("/api/pending/:id/approve", (c) => c.json({ error: "not implemented" }, 501));

  // TODO: dequeue and appendEvent("rejected"); the tool stays blocked. Returns 204.
  app.post("/api/pending/:id/reject", (c) => c.json({ error: "not implemented" }, 501));

  // The newest events, oldest first. ?limit= defaults to DEFAULT_EVENT_LIMIT. Returns LatchEvent[].
  app.get("/api/events", async (c) => c.json(await readEvents(deps.stateDir, eventLimit(c.req.query("limit")))));

  // The approved state in latch.lock. Returns LockFile.
  app.get("/api/lockfile", async (c) => c.json(await readLockfile(deps.lockfilePath)));

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
    // Unexpected: a damaged lockfile or queue, a disk error. Report it; never answer with partial data.
    console.error(`[latch ui] ${c.req.method} ${c.req.path} failed:`, error);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  return app;
}
