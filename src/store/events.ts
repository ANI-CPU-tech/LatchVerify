import type { Tier } from "../schema/index.js";

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

/** TODO: append JSON.stringify(event) + "\n" to <stateDir>/events.jsonl, creating stateDir if needed. */
export async function appendEvent(stateDir: string, event: LatchEvent): Promise<void> {
  throw new Error("not implemented");
}

/** TODO: read the log, skipping malformed lines, and return the newest `limit` events (oldest first). */
export async function readEvents(stateDir: string, limit?: number): Promise<LatchEvent[]> {
  throw new Error("not implemented");
}
