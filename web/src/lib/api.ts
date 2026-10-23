import { z } from "zod";
import { PendingChangeSchema, type PendingChange } from "@schema/index.js";

/** One diff part as produced by jsdiff (src/analyze/differ.ts diffDescription). */
export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * What the review screen renders. The review API returns PendingChange records, which store
 * hashes rather than description text, so the description fields are null for live data and
 * only filled in for the bundled sample data.
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

/** A live pending change as the review screen renders it. Description text is not available. */
export function toReviewItem(change: PendingChange): ReviewItem {
  return { change, descriptionBefore: null, descriptionAfter: null, descriptionDiff: null };
}

/**
 * The review queue, in the order the API returns it (highest tier first). Every entry is
 * validated with PendingChangeSchema: a malformed reply is an ApiError, never rendered as is.
 */
export async function fetchPending(signal?: AbortSignal): Promise<ReviewItem[]> {
  const response = await call("/api/pending", { signal });
  if (!isJson(response)) throw new ApiUnreachableError("The review API did not answer with JSON; is it running?");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.status, "The review API sent malformed JSON");
  }
  const result = PendingQueueSchema.safeParse(body);
  if (!result.success) throw new ApiError(response.status, `The review API sent an invalid queue:\n${z.prettifyError(result.error)}`);
  return result.data.map(toReviewItem);
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
