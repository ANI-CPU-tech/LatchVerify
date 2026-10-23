import { randomBytes, randomUUID } from "node:crypto";
import { emptyCapabilitySet, extractCapabilities } from "../analyze/capabilities.js";
import { diffCapabilities, diffHashes, type SegmentChanges } from "../analyze/differ.js";
import { hashTool, sha256Hex } from "../analyze/hash.js";
import { detectPatterns } from "../analyze/patterns.js";
import { classifyTier } from "../analyze/tiers.js";
import { detectUnicode } from "../analyze/unicode.js";
import { McpToolSchema, type Finding, type LockFile, type McpTool, type PendingChange, type ToolRecord } from "../schema/index.js";
import { findRecord } from "../store/lockfile.js";

/** approvedBy on a pending change's `after` record. applyApproval replaces it with the reviewer. */
export const UNAPPROVED = "unapproved";

/** specVersion recorded when the proxy did not see the initialize exchange. */
export const UNKNOWN_SPEC_VERSION = "unknown";

/** A tool that is new or differs from latch.lock, ready for the pending queue. */
export interface DetectedChange {
  change: PendingChange;
  /** Why the change got its tier, for logs. */
  reason: string;
}

/** Result of analyzing one tools/list result. */
export interface ListAnalysis {
  /** Entries in the list, valid or not. */
  toolCount: number;
  /** One per tool that is new or differs from its pinned record. */
  changes: DetectedChange[];
  /** Tools whose definition matches latch.lock exactly. */
  unchanged: string[];
}

/**
 * Run the analysis pipeline over a tools/list `result` for `serverId`: per tool, hash the
 * segments, extract capabilities (cross-server references count tools pinned for other servers,
 * except names this list also has), run the Unicode and pattern detectors over every text field,
 * diff against the pinned record and classify a tier. A tool whose composite hash matches its
 * pinned record is unchanged and not re-analyzed, so a detector update never causes phantom
 * drift on an approved definition.
 *
 * Fails closed: a tool that cannot be analyzed (it does not match the MCP tool schema, its
 * schema is too deep or holds values JSON cannot represent, or its name is listed twice) becomes
 * a tier-3 change whose hashes never match any pin, so calls to it stay blocked until the server
 * serves something analyzable. Entries without a usable name are only counted: no call can
 * address them.
 *
 * Returns null when `result` is not an object with a `tools` array.
 */
export function analyzeToolList(
  serverId: string,
  result: unknown,
  lockfile: LockFile,
  specVersion: string | null,
  now: Date,
): ListAnalysis | null {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return null;
  const named = result.tools.map((raw) => ({ raw, name: toolName(raw) }));
  // Names this server lists itself are not references to another server: clients namespace tools
  // per server, so two servers may both have a "search" tool, and each mentions its own.
  const own = new Set(named.map(({ name }) => name));
  const knownTools = otherServerTools(lockfile, serverId).filter((name) => !own.has(name));
  const counts = new Map<string, number>();
  for (const { name } of named) if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);

  const analysis: ListAnalysis = { toolCount: result.tools.length, changes: [], unchanged: [] };
  const context: ToolContext = { serverId, lockfile, specVersion: specVersion ?? UNKNOWN_SPEC_VERSION, now, knownTools };
  const reported = new Set<string>();
  for (const { raw, name } of named) {
    if (name === null || reported.has(name)) continue;
    reported.add(name);
    const listed = counts.get(name)!;
    const outcome =
      listed > 1
        ? unanalyzable(context, name, `the tool is listed ${listed} times; a client could call either definition`)
        : analyzeTool(context, name, raw);
    if (outcome === "unchanged") analysis.unchanged.push(name);
    else analysis.changes.push(outcome);
  }
  return analysis;
}

interface ToolContext {
  serverId: string;
  lockfile: LockFile;
  specVersion: string;
  now: Date;
  /** Tool names pinned for other servers, for cross-server reference checks. */
  knownTools: string[];
}

function analyzeTool(context: ToolContext, name: string, raw: unknown): DetectedChange | "unchanged" {
  const parsed = McpToolSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return unanalyzable(context, name, `the definition does not match the MCP tool schema${where}: ${issue?.message ?? "invalid"}`);
  }
  const tool = parsed.data;
  const before = findRecord(context.lockfile, context.serverId, name) ?? null;
  try {
    const hashes = hashTool(tool);
    if (before !== null && before.hashes.composite === hashes.composite) return "unchanged";

    const { capabilities, findings } = extractCapabilities(tool, context.knownTools);
    findings.push(...textFindings(tool, context.knownTools));
    const segments: SegmentChanges =
      before === null ? { name: true, description: true, inputSchema: true, metadata: true } : diffHashes(before.hashes, hashes);
    const capabilityDelta = diffCapabilities(before?.capabilities ?? null, capabilities);
    const decision = classifyTier(segments, capabilityDelta, findings);
    const after: ToolRecord = {
      name,
      serverId: context.serverId,
      hashes,
      capabilities,
      approvedBy: UNAPPROVED,
      approvedAt: context.now.toISOString(),
      specVersion: context.specVersion,
    };
    return {
      change: {
        id: newChangeId(),
        serverId: context.serverId,
        toolName: name,
        tier: decision.tier,
        detectedAt: context.now.toISOString(),
        before,
        after,
        capabilityDelta,
        findings,
      },
      reason: decision.reason,
    };
  } catch (error) {
    return unanalyzable(context, name, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A tier-3 change for a tool that could not be analyzed. Its hashes are random, so it can never
 * equal a pinned record and the blocker never treats it as approved.
 */
function unanalyzable(context: ToolContext, name: string, problem: string): DetectedChange {
  const nonce = sha256Hex(`unanalyzable:${randomUUID()}`);
  const message = `Tool definition could not be analyzed: ${problem}`;
  return {
    change: {
      id: newChangeId(),
      serverId: context.serverId,
      toolName: name,
      tier: 3,
      detectedAt: context.now.toISOString(),
      before: findRecord(context.lockfile, context.serverId, name) ?? null,
      after: {
        name,
        serverId: context.serverId,
        hashes: { name: nonce, description: nonce, inputSchema: nonce, metadata: nonce, composite: nonce },
        capabilities: emptyCapabilitySet(),
        approvedBy: UNAPPROVED,
        approvedAt: context.now.toISOString(),
        specVersion: context.specVersion,
      },
      capabilityDelta: { gained: [], lost: [], loosened: [] },
      findings: [{ type: "capability_gain", severity: "critical", message, evidence: "" }],
    },
    reason: message,
  };
}

/**
 * Unicode findings for every string and property name a client shows the model, and pattern
 * findings for the prose among them (name, title, description, and every title and description
 * nested in inputSchema). Hidden instructions are as dangerous in a parameter description as in
 * the tool description.
 */
function textFindings(tool: McpTool, knownTools: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const prose = (text: string, field: string) => {
    findings.push(...detectUnicode(text, field), ...detectPatterns(text, field, { otherServerTools: knownTools }));
  };
  prose(tool.name, "name");
  if (tool.title !== undefined) prose(tool.title, "title");
  if (tool.description !== undefined) prose(tool.description, "description");
  if (typeof tool.annotations?.title === "string") prose(tool.annotations.title, "annotations.title");

  // hashTool already bounded the nesting depth, so this walk cannot overflow the stack.
  const walk = (value: unknown, field: string, key: string | undefined): void => {
    if (typeof value === "string") {
      if (key === "description" || key === "title") prose(value, field);
      else findings.push(...detectUnicode(value, field));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${field}[${i}]`, undefined));
    } else if (isPlainObject(value)) {
      for (const [name, child] of Object.entries(value)) {
        findings.push(...detectUnicode(name, `${field} key`));
        walk(child, `${field}.${name}`, name);
      }
    }
  };
  walk(tool.inputSchema, "inputSchema", undefined);
  return findings;
}

/** The tool's name when it has a non-empty string one, else null. */
function toolName(raw: unknown): string | null {
  return isPlainObject(raw) && typeof raw.name === "string" && raw.name !== "" ? raw.name : null;
}

function otherServerTools(lockfile: LockFile, serverId: string): string[] {
  return Object.entries(lockfile.servers)
    .filter(([id]) => id !== serverId)
    .flatMap(([, server]) => server.tools.map((tool) => tool.name));
}

/** "chg_" plus 12 random hex digits. */
function newChangeId(): string {
  return `chg_${randomBytes(6).toString("hex")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
