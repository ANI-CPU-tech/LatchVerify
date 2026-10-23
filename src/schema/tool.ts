import { z } from "zod";
import { CapabilitySetSchema, FindingSchema } from "./capability.js";

/** Lowercase SHA-256 hex digest. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected lowercase SHA-256 hex digest");
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/**
 * A raw tool definition exactly as an MCP server returns it in `tools/list`.
 * Loose on purpose: the proxy must forward fields it does not model.
 */
export const McpToolSchema = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.looseObject({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }),
  annotations: z
    .looseObject({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

/** `result` payload of a `tools/list` response. */
export const McpToolListSchema = z.looseObject({
  tools: z.array(McpToolSchema),
  nextCursor: z.string().optional(),
});
export type McpToolList = z.infer<typeof McpToolListSchema>;

/**
 * Per-segment hashes. Segmenting lets the differ say *which* part changed
 * (a description reword vs. an inputSchema change) without storing the text.
 */
export const ToolHashesSchema = z.object({
  name: Sha256HexSchema,
  description: Sha256HexSchema,
  inputSchema: Sha256HexSchema,
  /** Hash over the three segment hashes; the quick equality check. */
  composite: Sha256HexSchema,
});
export type ToolHashes = z.infer<typeof ToolHashesSchema>;

/**
 * Cached LLM advisory result. Keyed by content hash and committed with the
 * record so re-runs never re-query the model and never produce phantom drift.
 */
export const LlmAdvisorySchema = z.object({
  contentHash: Sha256HexSchema,
  model: z.string().min(1),
  findings: z.array(FindingSchema),
});
export type LlmAdvisory = z.infer<typeof LlmAdvisorySchema>;

/** Approved state of one tool, as pinned in latch.lock. */
export const ToolRecordSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  hashes: ToolHashesSchema,
  capabilities: CapabilitySetSchema,
  approvedBy: z.string().min(1),
  approvedAt: z.iso.datetime(),
  /** MCP protocol revision the definition was captured under, e.g. "2025-06-18". */
  specVersion: z.string().min(1),
  advisory: LlmAdvisorySchema.optional(),
});
export type ToolRecord = z.infer<typeof ToolRecordSchema>;
