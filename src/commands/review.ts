export interface ReviewOptions {
  /** Open the web UI instead of the terminal flow. */
  ui: boolean;
  port: number;
  lockfilePath: string;
  stateDir: string;
}

/**
 * `latch review`
 * TODO: load the pending queue. With --ui start the hono server and open the browser. Otherwise
 * walk each change in tier order (3 first) with @clack/prompts, showing the capability delta,
 * findings and description diff, then approve (applyApproval + writeLockfile + dequeue) or reject.
 * Resolves with the process exit code.
 */
export async function runReview(options: ReviewOptions): Promise<number> {
  throw new Error("not implemented");
}
