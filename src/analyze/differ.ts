import type { CapabilityDelta, CapabilitySet, ToolHashes } from "../schema/index.js";

/** Which hash segments changed between two records. */
export interface SegmentChanges {
  name: boolean;
  description: boolean;
  inputSchema: boolean;
}

/** TODO: compare each segment hash. All false means the definitions are byte-identical. */
export function diffHashes(before: ToolHashes, after: ToolHashes): SegmentChanges {
  throw new Error("not implemented");
}

/**
 * Diff capabilities, not text.
 * TODO: flatten both sets to dotted keys ("filesystem.read", "exec.shell", "network.egress",
 * "credentials.readsEnv", "crossServerRefs:<name>", ...). gained = true only in `after`;
 * lost = true only in `before`; loosened = filesystem.scope widening (none < constrained <
 * unconstrained), network.unconstrained flipping on, or paths/domains allow-lists growing.
 * `before` null (new tool) means every true key in `after` is gained.
 */
export function diffCapabilities(before: CapabilitySet | null, after: CapabilitySet): CapabilityDelta {
  throw new Error("not implemented");
}

/**
 * Line diff of two description strings for the review UI.
 * TODO: wrap jsdiff's diffWordsWithSpace and return the parts with added/removed flags.
 */
export function diffDescription(
  before: string,
  after: string,
): Array<{ value: string; added: boolean; removed: boolean }> {
  throw new Error("not implemented");
}
