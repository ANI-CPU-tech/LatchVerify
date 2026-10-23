import { Hono } from "hono";

/** Filesystem locations the review API reads and writes. */
export interface RouteDeps {
  lockfilePath: string;
  stateDir: string;
  /** Identity recorded as approvedBy, e.g. the git user.email. */
  reviewer: string;
}

/**
 * Review API consumed by web/src/lib/api.ts. Every handler is a 501 placeholder that
 * documents the contract it will implement.
 */
export function createRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const notImplemented = { error: "not implemented" } as const;

  // TODO: readPending(deps.stateDir) sorted by tier desc then detectedAt. Returns PendingChange[].
  app.get("/api/pending", (c) => c.json(notImplemented, 501));

  // TODO: one PendingChange by id, or 404.
  app.get("/api/pending/:id", (c) => c.json(notImplemented, 501));

  // TODO: applyApproval(lockfile, change, deps.reviewer) → writeLockfile → dequeue → appendEvent("approved").
  // Returns the updated ToolRecord. The user still commits latch.lock and opens a PR.
  app.post("/api/pending/:id/approve", (c) => c.json(notImplemented, 501));

  // TODO: dequeue and appendEvent("rejected"); the tool stays blocked. Returns 204.
  app.post("/api/pending/:id/reject", (c) => c.json(notImplemented, 501));

  // TODO: readEvents(deps.stateDir, Number(c.req.query("limit") ?? 100)). Returns LatchEvent[].
  app.get("/api/events", (c) => c.json(notImplemented, 501));

  // TODO: readLockfile(deps.lockfilePath). Returns LockFile.
  app.get("/api/lockfile", (c) => c.json(notImplemented, 501));

  return app;
}
