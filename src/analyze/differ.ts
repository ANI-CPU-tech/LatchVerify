import { diffWordsWithSpace } from "diff";
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
 *   unconstrained), "network.unconstrained" when any URL becomes acceptable, and
 *   "filesystem.paths:<path>" / "network.domains:<host>" for each entry added to an allow-list
 *   that is constrained on both sides (a list appearing or vanishing is already a scope change);
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

  if (base.filesystem.scope === "constrained" && after.filesystem.scope === "constrained") {
    diffAllowList("filesystem.paths", base.filesystem.paths, after.filesystem.paths, loosened, lost);
  }
  if (isPinnedNetwork(base) && isPinnedNetwork(after)) {
    diffAllowList("network.domains", base.network.domains, after.network.domains, loosened, lost);
  }

  return { gained: sortedUnique(gained), lost: sortedUnique(lost), loosened: sortedUnique(loosened) };
}

/** Egress limited to schema-pinned destinations. */
const isPinnedNetwork = (caps: CapabilitySet): boolean => caps.network.egress && !caps.network.unconstrained;

/** Entries added to an allow-list widen it; entries removed narrow it. */
function diffAllowList(key: string, before: readonly string[], after: readonly string[], loosened: string[], lost: string[]): void {
  const had = new Set(before);
  const has = new Set(after);
  for (const entry of has) if (!had.has(entry)) loosened.push(`${key}:${entry}`);
  for (const entry of had) if (!has.has(entry)) lost.push(`${key}:${entry}`);
}

/** One run of a description diff, as the review UI renders it. */
export interface DescriptionPart {
  value: string;
  added: boolean;
  removed: boolean;
}

/**
 * Largest edit, in word and whitespace tokens, the description diff computes. Beyond it the
 * texts are effectively rewritten, so a whole-text replacement is shown instead. Keeps a hostile
 * multi-megabyte description from stalling the review API (worst case is milliseconds).
 */
export const MAX_DESCRIPTION_EDIT = 500;

/**
 * Word-level diff of two descriptions for the review UI (jsdiff diffWordsWithSpace): every
 * word, punctuation mark and whitespace run is a token, so inserted invisible characters show
 * up inside the changed word. Unchanged text has both flags false. Concatenating the parts that
 * are not added gives `before`; the parts that are not removed give `after`.
 */
export function diffDescription(before: string, after: string): DescriptionPart[] {
  if (before === after) return before ? [{ value: before, added: false, removed: false }] : [];
  const changes = diffWordsWithSpace(before, after, { maxEditLength: MAX_DESCRIPTION_EDIT });
  if (!changes) {
    const parts: DescriptionPart[] = [];
    if (before) parts.push({ value: before, added: false, removed: true });
    if (after) parts.push({ value: after, added: true, removed: false });
    return parts;
  }
  return changes
    .filter((change) => change.value.length > 0)
    .map(({ value, added, removed }) => ({ value, added, removed }));
}
