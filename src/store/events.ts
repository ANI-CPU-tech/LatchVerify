import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { LatchEventSchema, type LatchEvent } from "../schema/index.js";

/** File name of the append-only event log inside LATCH_STATE_DIR. */
export const EVENTS_FILE = "events.jsonl";

export type { LatchEvent } from "../schema/index.js";

/**
 * Append one event to <stateDir>/events.jsonl as a single JSON line, creating stateDir if
 * needed. Each event is one append-mode write, so concurrent writers (proxy, review UI) never
 * interleave inside a line.
 *
 * When the log does not end in a newline (a write torn by a crash or a full disk, or a hand
 * edit), the event starts on a fresh line, so it is not glued to the torn line and lost with it
 * when readEvents skips that line. Two writers repairing at once leave a blank line, which
 * readEvents skips.
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
  const handle = await open(join(stateDir, EVENTS_FILE), "a+");
  try {
    const { size } = await handle.stat();
    const torn = size > 0 && (await handle.read(Buffer.alloc(1), 0, 1, size - 1)).buffer[0] !== 0x0a;
    await handle.appendFile(`${torn ? "\n" : ""}${JSON.stringify(result.data)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Read <stateDir>/events.jsonl and return the newest `limit` events, oldest first (all events
 * when `limit` is omitted). A missing log is empty.
 *
 * Lines that are blank, not JSON, or not a valid LatchEvent (a torn final write, a hand edit,
 * an event kind from a newer version) are skipped, never thrown: the log is an audit trail and
 * one bad line must not hide the rest. The file is streamed, so memory stays proportional to
 * `limit`, not to the size of the log.
 *
 * @throws RangeError when `limit` is not a non-negative integer.
 */
export async function readEvents(stateDir: string, limit?: number): Promise<LatchEvent[]> {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new RangeError(`readEvents: limit must be a non-negative integer, got ${limit}`);
  }
  let handle: FileHandle;
  try {
    handle = await open(join(stateDir, EVENTS_FILE), "r");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: LatchEvent[] = [];
  try {
    const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      const event = parseEvent(line);
      if (event === null) continue;
      events.push(event);
      // Trim in batches: amortized O(1) per line instead of shifting on every push.
      if (limit !== undefined && events.length >= 2 * limit + 1024) events.splice(0, events.length - limit);
    }
  } finally {
    await handle.close();
  }
  return limit === undefined ? events : events.slice(events.length - limit);
}

/** One log line as a validated event, or null when it is blank, not JSON, or not a LatchEvent. */
function parseEvent(line: string): LatchEvent | null {
  if (line.trim() === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const result = LatchEventSchema.safeParse(data);
  return result.success ? result.data : null;
}
