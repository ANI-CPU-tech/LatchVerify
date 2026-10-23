export interface VerifyOptions {
  lockfilePath: string;
  /** Emit a machine-readable report instead of coloured text. */
  json: boolean;
}

/** Exit codes, the CI contract. Documented in docs/LOCKFILE.md. */
export const VERIFY_EXIT = {
  ok: 0,
  drift: 1,
  hardBlock: 2,
  error: 3,
} as const;

/**
 * `latch verify` (CI)
 * TODO: for every server in the lockfile, spawn it, request tools/list, and diff each tool against
 * its pinned record. Return VERIFY_EXIT.ok when nothing above tier 1 changed, drift on any tier-2
 * change or unpinned tool, hardBlock on any tier-3 change, error if a server fails to start.
 */
export async function runVerify(options: VerifyOptions): Promise<number> {
  throw new Error("not implemented");
}
