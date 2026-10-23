import { z } from "zod";
import { TierSchema, type Tier } from "./pending.js";

/**
 * Every observable decision the proxy or CLI makes: one line of .latch/events.jsonl.
 * Shared with the review UI, which validates GET /api/events against LatchEventSchema.
 */
export type LatchEvent =
  | { kind: "tools_listed"; at: string; serverId: string; toolCount: number }
  | { kind: "list_changed"; at: string; serverId: string }
  | { kind: "change_detected"; at: string; serverId: string; toolName: string; tier: Tier; changeId: string }
  | { kind: "auto_passed"; at: string; serverId: string; toolName: string; tier: Tier }
  | { kind: "call_blocked"; at: string; serverId: string; toolName: string; reason: string }
  | { kind: "approved"; at: string; serverId: string; toolName: string; changeId: string; approvedBy: string }
  | { kind: "rejected"; at: string; serverId: string; toolName: string; changeId: string };

// Runtime mirror of LatchEvent. Names stay unconstrained strings: a blocked call logs whatever
// tool name the client sent, and logging must not reject what actually happened.
const at = z.iso.datetime();
export const LatchEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tools_listed"), at, serverId: z.string(), toolCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("list_changed"), at, serverId: z.string() }),
  z.object({
    kind: z.literal("change_detected"),
    at,
    serverId: z.string(),
    toolName: z.string(),
    tier: TierSchema,
    changeId: z.string(),
  }),
  z.object({ kind: z.literal("auto_passed"), at, serverId: z.string(), toolName: z.string(), tier: TierSchema }),
  z.object({ kind: z.literal("call_blocked"), at, serverId: z.string(), toolName: z.string(), reason: z.string() }),
  z.object({
    kind: z.literal("approved"),
    at,
    serverId: z.string(),
    toolName: z.string(),
    changeId: z.string(),
    approvedBy: z.string(),
  }),
  z.object({ kind: z.literal("rejected"), at, serverId: z.string(), toolName: z.string(), changeId: z.string() }),
]);

// Compile-time guard: the schema and the LatchEvent type must describe the same events.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const schemaMatchesType: Same<z.infer<typeof LatchEventSchema>, LatchEvent> = true;
void schemaMatchesType;

export type LatchEventKind = LatchEvent["kind"];
