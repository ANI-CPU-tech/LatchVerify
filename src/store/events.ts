import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TierSchema, type Tier } from "../schema/index.js";

/** File name of the append-only event log inside LATCH_STATE_DIR. */
export const EVENTS_FILE = "events.jsonl";

/** Every observable decision the proxy or CLI makes. One JSON object per line. */
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
const LatchEventSchema = z.discriminatedUnion("kind", [
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

/**
 * Append one event to <stateDir>/events.jsonl as a single JSON line, creating stateDir if
 * needed. Each event is one append-mode write, so concurrent writers (proxy, review UI) never
 * interleave inside a line.
 *
 * @throws TypeError before writing when the event does not match LatchEvent at runtime (for
 * example a malformed `at`), so every line written can be read back.
 */
export async function appendEvent(stateDir: string, event: LatchEvent): Promise<void> {
  const result = LatchEventSchema.safeParse(event);
  if (!result.success) {
    throw new TypeError(`appendEvent: invalid event\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  await mkdir(stateDir, { recursive: true });
  await appendFile(join(stateDir, EVENTS_FILE), `${JSON.stringify(result.data)}\n`, "utf8");
}

/** TODO: read the log, skipping malformed lines, and return the newest `limit` events (oldest first). */
export async function readEvents(stateDir: string, limit?: number): Promise<LatchEvent[]> {
  throw new Error("not implemented");
}
