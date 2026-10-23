import type { PendingChange } from "@schema/index";

/** One diff part as produced by jsdiff (src/analyze/differ.ts diffDescription). */
export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * What the review screen renders. ToolRecord stores hashes only, so the API attaches the
 * description text and its precomputed diff alongside the PendingChange.
 */
export interface ReviewItem {
  change: PendingChange;
  descriptionBefore: string | null;
  descriptionAfter: string;
  descriptionDiff: DiffPart[];
}

/** TODO: GET /api/pending and validate each entry's change with PendingChangeSchema. */
export async function fetchPending(): Promise<ReviewItem[]> {
  throw new Error("not implemented");
}

/** TODO: POST /api/pending/:id/approve. Resolves once latch.lock has been rewritten. */
export async function approveChange(id: string): Promise<void> {
  throw new Error("not implemented");
}

/** TODO: POST /api/pending/:id/reject. The tool stays blocked. */
export async function rejectChange(id: string): Promise<void> {
  throw new Error("not implemented");
}
