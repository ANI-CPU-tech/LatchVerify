import { z } from "zod";
import { FindingSchema } from "./capability.js";
import { ToolRecordSchema } from "./tool.js";

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
});
export type PendingChange = z.infer<typeof PendingChangeSchema>;
