import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { PendingChange } from "../schema/index.js";
import { appendEvent, readEvents, type LatchEvent } from "../store/events.js";
import { applyApproval, findRecord, readLockfile, writeLockfile } from "../store/lockfile.js";
import { dequeue, readPending, writePending } from "../store/pending.js";

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
 * Runs mutations one at a time. Approve and reject each read, then rewrite, latch.lock and the
 * queue; two running at once would lose one of the writes.
 * shortcut: serializes this process only; the proxy also writes the queue, so cross-process
 * locking belongs in store/pending.ts if both ever run against the same state directory.
 */
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Records an event without failing the request: the decision is already saved to disk. */
async function logEvent(stateDir: string, event: LatchEvent): Promise<void> {
  try {
    await appendEvent(stateDir, event);
  } catch (error) {
    console.error(`[latch ui] could not log ${event.kind} event:`, error);
  }
}

/**
 * Review API consumed by web/src/lib/api.ts. Every response is JSON; errors are
 * `{ "error": message }` with a 4xx status for client mistakes and 500 otherwise.
 */
export function createRoutes(deps: RouteDeps): Hono {
  const reviewer = deps.reviewer.trim();
  if (reviewer.length === 0) throw new TypeError("createRoutes: reviewer must not be empty; approvals record who made them");
  const now = deps.now ?? (() => new Date());
  const exclusive = createMutex();
  const app = new Hono();

  /** The pending change with this id, or a 404. */
  const pendingById = async (id: string): Promise<{ queue: PendingChange[]; change: PendingChange }> => {
    const queue = await readPending(deps.stateDir);
    const change = queue.find((entry) => entry.id === id);
    if (!change) throw new ApiError(404, `no pending change "${id}"`);
    return { queue, change };
  };

  // The review queue, highest tier first, oldest first within a tier. Returns PendingChange[].
  app.get("/api/pending", async (c) => c.json((await readPending(deps.stateDir)).sort(reviewOrder)));

  // One pending change by id, or 404.
  app.get("/api/pending/:id", async (c) => c.json((await pendingById(c.req.param("id"))).change));

  // Approve: pin the change's definition in latch.lock, drop it from the queue, log it. Returns the
  // new ToolRecord. The user still commits latch.lock and opens a pull request for review.
  // latch.lock is written before the queue: a crash in between leaves the change queued, and
  // approving it again is idempotent. The reverse order could lose an approval.
  app.post("/api/pending/:id/approve", (c) =>
    exclusive(async () => {
      const { queue, change } = await pendingById(c.req.param("id"));
      const lock = await readLockfile(deps.lockfilePath); // unreadable or invalid: 500
      const at = now();
      let approved;
      try {
        approved = applyApproval(lock, change, reviewer, at);
      } catch (error) {
        // The change cannot be recorded as it stands: unknown server, record for another tool.
        throw new ApiError(409, error instanceof Error ? error.message : String(error));
      }
      await writeLockfile(deps.lockfilePath, approved);
      await writePending(deps.stateDir, dequeue(queue, change.id));
      await logEvent(deps.stateDir, {
        kind: "approved",
        at: at.toISOString(),
        serverId: change.serverId,
        toolName: change.toolName,
        changeId: change.id,
        approvedBy: reviewer,
      });
      return c.json(findRecord(approved, change.serverId, change.toolName));
    }),
  );

  // Reject: drop the change from the queue and log it. latch.lock is untouched, so the tool stays
  // blocked until a definition is approved. Returns 204.
  app.post("/api/pending/:id/reject", (c) =>
    exclusive(async () => {
      const { queue, change } = await pendingById(c.req.param("id"));
      await writePending(deps.stateDir, dequeue(queue, change.id));
      await logEvent(deps.stateDir, {
        kind: "rejected",
        at: now().toISOString(),
        serverId: change.serverId,
        toolName: change.toolName,
        changeId: change.id,
      });
      return c.body(null, 204);
    }),
  );

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
