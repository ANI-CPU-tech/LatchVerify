import type { CapabilityDelta, Finding, Tier } from "../schema/index.js";
import type { SegmentChanges } from "./differ.js";

/** Capability keys whose gain is always tier 3. */
export const TIER3_CAPABILITY_KEYS: readonly string[] = [
  "exec.enabled",
  "exec.shell",
  "credentials.readsEnv",
  "credentials.readsSecrets",
];

/** Tier plus the human-readable reason shown in the review UI and event log. */
export interface TierDecision {
  tier: Tier;
  reason: string;
}

/**
 * Classify a change. First matching rule wins:
 * 3: any critical unicode/pattern/cross_server finding, or a gained TIER3_CAPABILITY_KEYS key.
 * 2: anything in delta.gained or delta.loosened.
 * 1: delta.lost non-empty (narrowed) with nothing gained.
 * 0: segments changed but the capability set is identical. Auto-pass is mandatory: descriptions
 *    change on every version bump, and blocking them trains users to disable the tool.
 * TODO: implement the rules above and return the tier with its reason.
 */
export function classifyTier(segments: SegmentChanges, delta: CapabilityDelta, findings: readonly Finding[]): TierDecision {
  throw new Error("not implemented");
}

/** TODO: true for tier 0 and 1 (auto-pass, log only); false for 2 and 3 (block). */
export function isAutoPass(tier: Tier): boolean {
  throw new Error("not implemented");
}
