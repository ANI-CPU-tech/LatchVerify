import { z } from "zod";
import { FindingSchema } from "./capability.js";
import { Sha256HexSchema, ToolRecordSchema } from "./tool.js";

/**
 * Change tiers.
 * 0 text changed, capabilities identical: auto-pass, log.
 * 1 capability narrowed or constraint added: auto-pass, log.
 * 2 capability gained or constraint loosened: block, queue for review.
 * 3 hidden instruction, Unicode obfuscation, cross-server ref, exec/credential gain: hard block, alert.
 */
export const TierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof TierSchema>;

/** Capability keys (e.g. "filesystem.read") that moved between before and after. */
export const CapabilityDeltaSchema = z.object({
  gained: z.array(z.string()),
  lost: z.array(z.string()),
  loosened: z.array(z.string()),
});
export type CapabilityDelta = z.infer<typeof CapabilityDeltaSchema>;

/** Longest served description kept on a pending change, in UTF-16 code units. */
export const MAX_SERVED_DESCRIPTION = 16_384;

/** A detected tool change awaiting (or exempt from) human review. Lives in .latch/, not git. */
export const PendingChangeSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  tier: TierSchema,
  detectedAt: z.iso.datetime(),
  /** null when the tool was never pinned (newly appeared). */
  before: ToolRecordSchema.nullable(),
  after: ToolRecordSchema,
  capabilityDelta: CapabilityDeltaSchema,
  findings: z.array(FindingSchema),
  /**
   * The description the server served with `after`, so a reviewer reads what the model would
   * have read (latch.lock keeps only hashes). Cut to MAX_SERVED_DESCRIPTION characters. Absent
   * when the tool had no description or could not be analyzed, and in queues written before it
   * was recorded.
   */
  description: z.string().max(MAX_SERVED_DESCRIPTION + 100).optional(),
});
export type PendingChange = z.infer<typeof PendingChangeSchema>;

/**
 * A definition a reviewer rejected: the served tool whose composite hash it was. Kept in
 * .latch/rejected.json so the rejection outlives the proxy session, and a call to the tool stays
 * blocked for as long as the server serves exactly that definition.
 */
export const RejectionSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  composite: Sha256HexSchema,
  tier: TierSchema,
  changeId: z.string().min(1),
  rejectedAt: z.iso.datetime(),
});
export type Rejection = z.infer<typeof RejectionSchema>;
