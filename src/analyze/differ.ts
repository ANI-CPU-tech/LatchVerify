import type { CapabilityDelta, CapabilitySet, ToolHashes } from "../schema/index.js";
import { emptyCapabilitySet } from "./capabilities.js";

/** Which hash segments changed between two records. */
export interface SegmentChanges {
  name: boolean;
  description: boolean;
  inputSchema: boolean;
}

/**
 * Which hash segments differ between two records. All false means the three hashed segments
 * (name, description, canonical inputSchema) are identical.
 */
export function diffHashes(before: ToolHashes, after: ToolHashes): SegmentChanges {
  return {
    name: before.name !== after.name,
    description: before.description !== after.description,
    inputSchema: before.inputSchema !== after.inputSchema,
  };
}

/** True when any segment changed. */
export function anySegmentChanged(segments: SegmentChanges): boolean {
  return segments.name || segments.description || segments.inputSchema;
}

/** Boolean capabilities, by delta key. True in one set and not the other is a gain or a loss. */
const CAPABILITY_FLAGS: ReadonlyArray<readonly [string, (caps: CapabilitySet) => boolean]> = [
  ["filesystem.read", (c) => c.filesystem.read],
  ["filesystem.write", (c) => c.filesystem.write],
  ["exec.enabled", (c) => c.exec.enabled],
  ["exec.shell", (c) => c.exec.shell],
  ["network.egress", (c) => c.network.egress],
  ["credentials.readsEnv", (c) => c.credentials.readsEnv],
  ["credentials.readsSecrets", (c) => c.credentials.readsSecrets],
];

/** Delta key prefix for a cross-server reference: "crossServerRefs:send_email". */
export const CROSS_SERVER_PREFIX = "crossServerRefs:";

const SCOPE_RANK: Record<CapabilitySet["filesystem"]["scope"], number> = { none: 0, constrained: 1, unconstrained: 2 };

/** Delta keys of every capability the set has. */
function capabilityKeys(caps: CapabilitySet): Set<string> {
  const keys = new Set<string>();
  for (const [key, has] of CAPABILITY_FLAGS) if (has(caps)) keys.add(key);
  for (const ref of caps.crossServerRefs) keys.add(`${CROSS_SERVER_PREFIX}${ref}`);
  return keys;
}

const sortedUnique = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * Diffs capabilities, not text. Returns dotted delta keys, each list sorted and unique:
 * - gained / lost: boolean capabilities ("filesystem.read", "exec.shell", "network.egress",
 *   "credentials.readsSecrets", ...) and cross-server references ("crossServerRefs:send_email")
 *   present on only one side;
 * - loosened: a constraint removed. "filesystem.scope" when scope widens (none < constrained <
 *   unconstrained), "network.unconstrained" when any URL becomes acceptable;
 * - lost also takes the opposite width changes: a constraint added narrows the tool.
 * `before` null (a tool seen for the first time) is compared with the empty set, so every
 * capability it has is gained. Declared annotations are claims, not capabilities, and are not
 * diffed; contradictions surface as annotation_mismatch findings instead.
 */
export function diffCapabilities(before: CapabilitySet | null, after: CapabilitySet): CapabilityDelta {
  const base = before ?? emptyCapabilitySet();
  const had = capabilityKeys(base);
  const has = capabilityKeys(after);
  const gained = [...has].filter((key) => !had.has(key));
  const lost = [...had].filter((key) => !has.has(key));
  const loosened: string[] = [];

  const scopeChange = SCOPE_RANK[after.filesystem.scope] - SCOPE_RANK[base.filesystem.scope];
  if (scopeChange > 0) loosened.push("filesystem.scope");
  if (scopeChange < 0) lost.push("filesystem.scope");

  if (after.network.unconstrained && !base.network.unconstrained) loosened.push("network.unconstrained");
  if (!after.network.unconstrained && base.network.unconstrained) lost.push("network.unconstrained");

  return { gained: sortedUnique(gained), lost: sortedUnique(lost), loosened: sortedUnique(loosened) };
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
