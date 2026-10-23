import type { CapabilityDelta, Finding, Tier } from "../schema/index.js";
import { CROSS_SERVER_PREFIX, anySegmentChanged, type SegmentChanges } from "./differ.js";

/** Capability keys whose gain is always tier 3. */
export const TIER3_CAPABILITY_KEYS: readonly string[] = [
  "exec.enabled",
  "exec.shell",
  "credentials.readsEnv",
  "credentials.readsSecrets",
];

/** Finding types whose critical findings mean hidden or hostile intent. */
const TIER3_FINDING_TYPES: ReadonlySet<Finding["type"]> = new Set(["unicode", "pattern", "cross_server"]);

/** Tier plus the human-readable reason shown in the review UI and event log. */
export interface TierDecision {
  tier: Tier;
  reason: string;
}

/** Gaining exec or credential access, or a reference to another server's tool. */
const isTier3Gain = (key: string): boolean => TIER3_CAPABILITY_KEYS.includes(key) || key.startsWith(CROSS_SERVER_PREFIX);

/** Keys named in a reason before the rest are counted. */
const REASON_KEY_LIMIT = 5;

const listKeys = (keys: readonly string[]): string =>
  keys.length <= REASON_KEY_LIMIT
    ? keys.join(", ")
    : `${keys.slice(0, REASON_KEY_LIMIT).join(", ")} and ${keys.length - REASON_KEY_LIMIT} more`;

/**
 * Classifies a change. First matching rule wins:
 * - unchanged: no hashed segment changed and the capabilities are identical. Tier 0 whatever the
 *   findings: this exact definition was already approved, and re-flagging it after a detector
 *   update would be phantom drift.
 * - 3: any critical unicode, pattern or cross_server finding; or a gained TIER3_CAPABILITY_KEYS
 *   key (exec, credentials) or cross-server reference. Hard block.
 * - 2: anything in delta.gained or delta.loosened. Block and queue for review.
 * - 1: delta.lost non-empty (narrowed, or a constraint added) with nothing gained. Auto-pass.
 * - 0: segments changed but the capability set is identical. Auto-pass is mandatory:
 *   descriptions change on every version bump, and blocking them trains users to disable the tool.
 * Annotation mismatches and other warn findings never raise the tier on their own; they are
 * shown to the reviewer of a change that is already blocked.
 */
export function classifyTier(segments: SegmentChanges, delta: CapabilityDelta, findings: readonly Finding[]): TierDecision {
  const capabilitiesChanged = delta.gained.length > 0 || delta.lost.length > 0 || delta.loosened.length > 0;
  if (!anySegmentChanged(segments) && !capabilitiesChanged) return { tier: 0, reason: "Definition unchanged" };

  const critical = findings.filter((f) => f.severity === "critical" && TIER3_FINDING_TYPES.has(f.type));
  if (critical.length > 0) {
    const [first] = critical;
    const more = critical.length > 1 ? ` (and ${critical.length - 1} more critical findings)` : "";
    return { tier: 3, reason: `Critical ${first!.type} finding: ${first!.message}${more}` };
  }

  const tier3Gains = delta.gained.filter(isTier3Gain);
  if (tier3Gains.length > 0) return { tier: 3, reason: `Gained ${listKeys(tier3Gains)}` };

  if (delta.gained.length > 0 || delta.loosened.length > 0) {
    const parts = [];
    if (delta.gained.length > 0) parts.push(`gained ${listKeys(delta.gained)}`);
    if (delta.loosened.length > 0) parts.push(`loosened ${listKeys(delta.loosened)}`);
    const reason = parts.join("; ");
    return { tier: 2, reason: reason.charAt(0).toUpperCase() + reason.slice(1) };
  }

  if (delta.lost.length > 0) return { tier: 1, reason: `Narrowed: ${listKeys(delta.lost)}` };

  const changed = (["name", "description", "inputSchema"] as const).filter((segment) => segments[segment]);
  return { tier: 0, reason: `Text changed (${changed.join(", ")}); capabilities unchanged` };
}

/** True for tiers 0 and 1, which auto-pass and are only logged; false for 2 and 3, which block. */
export function isAutoPass(tier: Tier): boolean {
  return tier <= 1;
}
