import { z } from "zod";
import {
  LatchEventSchema,
  LockFileSchema,
  PendingChangeSchema,
  SimulationResultSchema,
  type LatchEvent,
  type LockFile,
  type PendingChange,
  type SimulationRequest,
  type SimulationResult,
} from "@schema/index.js";

/** One diff part as produced by jsdiff (src/analyze/differ.ts diffDescription). */
export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * What the review screen renders. latch.lock stores hashes rather than description text, so a
 * live change has only the description the server serves now (`change.description`): no
 * previous text and no diff. The bundled sample data fills in all three.
 */
export interface ReviewItem {
  change: PendingChange;
  descriptionBefore: string | null;
  descriptionAfter: string | null;
  descriptionDiff: DiffPart[] | null;
}

/**
 * Header the review API requires on every write (src/ui/routes.ts CLIENT_HEADER). Defined here
 * rather than imported so the browser bundle does not pull in the server code.
 */
export const CLIENT_HEADER = "X-Latch-Client";
const CLIENT_NAME = "review-ui";

/** The API answered, but with an error. `message` is the API's own explanation. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The API could not be reached at all: not running, or the dev proxy has nothing behind it. */
export class ApiUnreachableError extends Error {
  override readonly name = "ApiUnreachableError";
}

/** Statuses a proxy (Vite in development) returns when the API behind it is down. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const PendingQueueSchema = z.array(PendingChangeSchema);
const EventLogSchema = z.array(LatchEventSchema);
const LockfileGitStatusSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    tracked: z.boolean(),
    modified: z.boolean(),
    lastCommit: z.object({ hash: z.string(), date: z.string(), subject: z.string() }).nullable(),
  }),
]);

const ApiInfoSchema = z.object({ version: z.string(), dev: z.boolean() });

const isJson = (response: Response): boolean => (response.headers.get("content-type") ?? "").includes("application/json");

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** The API's `{ error }` message, or the bare status when the body has none. */
async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  if (!isJson(response)) return fallback;
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Sends one request. Throws ApiUnreachableError when the API cannot be reached (network failure,
 * a gateway error from the dev proxy, or a non-JSON answer such as an HTML page), ApiError with
 * the server's message for any other failure, and rethrows aborts untouched.
 */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { Accept: "application/json", ...init.headers } });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiUnreachableError("Could not reach the LatchVerify review API", { cause: error });
  }
  if (GATEWAY_STATUSES.has(response.status)) {
    throw new ApiUnreachableError(`The LatchVerify review API is not running (HTTP ${response.status} from the proxy)`);
  }
  if (!response.ok) {
    if (!isJson(response)) throw new ApiUnreachableError(`Unexpected HTTP ${response.status} from ${path}; is the review API running?`);
    throw new ApiError(response.status, await errorMessage(response));
  }
  return response;
}

/** A live pending change as the review screen renders it: the served description, if recorded. */
export function toReviewItem(change: PendingChange): ReviewItem {
  return { change, descriptionBefore: null, descriptionAfter: change.description ?? null, descriptionDiff: null };
}

/**
 * GETs `path` (or sends `init`) and validates the JSON body with `schema`. A malformed or invalid
 * reply is an ApiError naming `what`, never rendered as is.
 */
async function getJson<T>(path: string, schema: z.ZodType<T>, what: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const response = await call(path, { ...init, signal });
  if (!isJson(response)) throw new ApiUnreachableError("The review API did not answer with JSON; is it running?");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.status, "The review API sent malformed JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(response.status, `The review API sent an invalid ${what}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** The review queue, in the order the API returns it (highest tier first). */
export async function fetchPending(signal?: AbortSignal): Promise<ReviewItem[]> {
  return (await getJson("/api/pending", PendingQueueSchema, "queue", signal)).map(toReviewItem);
}

/** Most events GET /api/events returns (src/ui/routes.ts MAX_EVENT_LIMIT). */
export const MAX_EVENTS = 1_000;

/** The newest `limit` events from .latch/events.jsonl, oldest first. */
export async function fetchEvents(limit: number = MAX_EVENTS, signal?: AbortSignal): Promise<LatchEvent[]> {
  return getJson(`/api/events?limit=${limit}`, EventLogSchema, "event log", signal);
}

/** What GET /api/info reports: the LatchVerify version, and whether development mode is on. */
export type ApiInfo = z.infer<typeof ApiInfoSchema>;

/** The serving LatchVerify's version and mode (LATCH_DEV). */
export async function fetchInfo(signal?: AbortSignal): Promise<ApiInfo> {
  return getJson("/api/info", ApiInfoSchema, "info", signal);
}

/** The approved state in latch.lock. */
export async function fetchLockfile(signal?: AbortSignal): Promise<LockFile> {
  return getJson("/api/lockfile", LockFileSchema, "lockfile", signal);
}

/** Git state of latch.lock (src/ui/git.ts LockfileGitStatus). */
export type LockfileGitStatus = z.infer<typeof LockfileGitStatusSchema>;

/** Whether latch.lock is tracked, has uncommitted changes, and its last commit. */
export async function fetchLockfileGit(signal?: AbortSignal): Promise<LockfileGitStatus> {
  return getJson("/api/lockfile/git", LockfileGitStatusSchema, "git status", signal);
}

const write = (id: string, action: "approve" | "reject"): Promise<Response> =>
  call(`/api/pending/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { [CLIENT_HEADER]: CLIENT_NAME } });

/** Approves a change. Resolves once the API has rewritten latch.lock and dequeued it. */
export async function approveChange(id: string): Promise<void> {
  await write(id, "approve");
}

/** Rejects a change. Resolves once it is dequeued; the tool stays blocked. */
export async function rejectChange(id: string): Promise<void> {
  await write(id, "reject");
}

/**
 * Rehearses a rug pull with the proxy's own pipeline (POST /api/simulate). Nothing is written:
 * not latch.lock, not the queue, not the event log.
 */
export async function simulateRugPull(request: SimulationRequest, signal?: AbortSignal): Promise<SimulationResult> {
  return getJson("/api/simulate", SimulationResultSchema, "simulation", signal, {
    method: "POST",
    headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_NAME },
    body: JSON.stringify(request),
  });
}
