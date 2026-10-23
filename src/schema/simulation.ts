import { z } from "zod";
import { PendingChangeSchema } from "./pending.js";
import { ToolRecordSchema } from "./tool.js";

/** Most tool calls a simulation replays on each side of the rug pull. */
export const MAX_SIMULATED_CALLS = 20;

/**
 * POST /api/simulate body: a rug pull to rehearse. The server serves `pinned` first and every
 * tool in it is approved; it then switches to `served`. `callsBefore` and `callsAfter` name the
 * tools/call requests a client makes on each side of the switch. Tool lists are tools/list
 * results and are validated by the analysis pipeline itself, which fails closed.
 */
export const SimulationRequestSchema = z.object({
  serverId: z.string().min(1).max(64),
  pinned: z.unknown(),
  served: z.unknown(),
  callsBefore: z.array(z.string().min(1).max(128)).max(MAX_SIMULATED_CALLS),
  callsAfter: z.array(z.string().min(1).max(128)).max(MAX_SIMULATED_CALLS),
});
export type SimulationRequest = z.infer<typeof SimulationRequestSchema>;

/** The JSON-RPC error the proxy returns in place of a blocked tools/call result. */
export const BlockErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
});
export type BlockErrorResponse = z.infer<typeof BlockErrorResponseSchema>;

/** One replayed tools/call: forwarded when `blocked` is null, else the error the client gets. */
export const SimulatedCallSchema = z.object({
  toolName: z.string(),
  blocked: BlockErrorResponseSchema.nullable(),
});
export type SimulatedCall = z.infer<typeof SimulatedCallSchema>;

/**
 * What the proxy would do, computed with the real pipeline in memory: the records pinned from
 * the first list, the verdict on each call before the switch, the changes found in the second
 * list (as they would be queued for review), and the verdict on each call after it.
 */
export const SimulationResultSchema = z.object({
  serverId: z.string(),
  pinned: z.array(ToolRecordSchema),
  callsBefore: z.array(SimulatedCallSchema),
  changes: z.array(PendingChangeSchema),
  unchanged: z.array(z.string()),
  callsAfter: z.array(SimulatedCallSchema),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
