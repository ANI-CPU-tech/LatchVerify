import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { LockFile, PendingChange } from "../schema/index.js";
import { appendEvent, readEvents, type LatchEvent } from "../store/events.js";
import { applyApproval, findRecord, readLockfile, writeLockfile } from "../store/lockfile.js";
import { dequeue, readPending, reviewOrder, updatePending } from "../store/pending.js";

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

/**
 * Header every state-changing request must carry. A web page on another origin cannot add a
 * custom header without a CORS preflight, and this API never grants one, so a drive-by page in
 * the reviewer's browser cannot approve or reject changes.
 */
export const CLIENT_HEADER = "X-Latch-Client";

/** Host names that reach this machine's loopback interface. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when `url`'s host is a loopback name; false for anything unparseable, including "null". */
function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Methods that only read. Everything else changes state and must prove it comes from the UI. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Parses ?limit= for the event log: a whole number from 0 to MAX_EVENT_LIMIT. */
function eventLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVENT_LIMIT;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) > MAX_EVENT_LIMIT) {
    throw new ApiError(400, `limit must be a whole number from 0 to ${MAX_EVENT_LIMIT}`);
  }
  return Number(raw);
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
 * `{ "error": message }` with a 4xx status for client mistakes and 500 otherwise. Requests must
 * reach it as localhost, and every write must carry CLIENT_HEADER (see the request guard).
 */
export function createRoutes(deps: RouteDeps): Hono {
  const reviewer = deps.reviewer.trim();
  if (reviewer.length === 0) throw new TypeError("createRoutes: reviewer must not be empty; approvals record who made them");
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  // Request guard, ahead of every route:
  // - Host must be loopback. A DNS-rebinding page reaches 127.0.0.1 under its own host name.
  // - Writes must come from a loopback Origin (when one is sent) and carry CLIENT_HEADER.
  // Responses are never cached and never content-sniffed.
  app.use("*", async (c, next) => {
    if (!isLoopbackUrl(c.req.url)) return c.json({ error: "the review API only answers on localhost" }, 403);
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isLoopbackUrl(origin)) return c.json({ error: `requests from ${origin} are not allowed` }, 403);
      if (c.req.header(CLIENT_HEADER) === undefined) return c.json({ error: `missing ${CLIENT_HEADER} header` }, 403);
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  /** The pending change with this id, or a 404. */
  const pendingById = (queue: PendingChange[], id: string): PendingChange => {
    const change = queue.find((entry) => entry.id === id);
    if (!change) throw new ApiError(404, `no pending change "${id}"`);
    return change;
  };

  // The review queue, highest tier first, oldest first within a tier. Returns PendingChange[].
  app.get("/api/pending", async (c) => c.json((await readPending(deps.stateDir)).sort(reviewOrder)));

  // One pending change by id, or 404.
  app.get("/api/pending/:id", async (c) => c.json(pendingById(await readPending(deps.stateDir), c.req.param("id"))));

  // Approve: pin the change's definition in latch.lock, drop it from the queue, log it. Returns the
  // new ToolRecord. The user still commits latch.lock and opens a pull request for review.
  // latch.lock is written before the queue: a crash in between leaves the change queued, and
  // approving it again is idempotent. The reverse order could lose an approval. Both happen under
  // the queue lock, so concurrent decisions and proxies never lose each other's writes.
  app.post("/api/pending/:id/approve", async (c) => {
    const at = now();
    const done: { change?: PendingChange; approved?: LockFile } = {};
    await updatePending(deps.stateDir, async (queue) => {
      const change = pendingById(queue, c.req.param("id"));
      const lock = await readLockfile(deps.lockfilePath); // unreadable or invalid: 500
      let approved;
      try {
        approved = applyApproval(lock, change, reviewer, at);
      } catch (error) {
        // The change cannot be recorded as it stands: unknown server, record for another tool.
        throw new ApiError(409, error instanceof Error ? error.message : String(error));
      }
      await writeLockfile(deps.lockfilePath, approved);
      Object.assign(done, { change, approved });
      return dequeue(queue, change.id);
    });
    const change = done.change!;
    await logEvent(deps.stateDir, {
      kind: "approved",
      at: at.toISOString(),
      serverId: change.serverId,
      toolName: change.toolName,
      changeId: change.id,
      approvedBy: reviewer,
    });
    return c.json(findRecord(done.approved!, change.serverId, change.toolName));
  });

  // Reject: drop the change from the queue and log it. latch.lock is untouched, so the tool stays
  // blocked until a definition is approved. Returns 204.
  app.post("/api/pending/:id/reject", async (c) => {
    const done: { change?: PendingChange } = {};
    await updatePending(deps.stateDir, (queue) => {
      done.change = pendingById(queue, c.req.param("id"));
      return dequeue(queue, done.change.id);
    });
    const change = done.change!;
    await logEvent(deps.stateDir, {
      kind: "rejected",
      at: now().toISOString(),
      serverId: change.serverId,
      toolName: change.toolName,
      changeId: change.id,
    });
    return c.body(null, 204);
  });

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
