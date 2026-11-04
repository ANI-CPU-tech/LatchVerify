import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { LatchEventSchema, type LatchEvent } from "../schema/index.js";
import { withFileLock } from "./lock.js";
import { replaceFile } from "./replace.js";

/** File name of the append-only event log inside LATCH_STATE_DIR. */
export const EVENTS_FILE = "events.jsonl";

/** The previous log, kept after rotation. Older entries than that are dropped. */
export const ROTATED_EVENTS_FILE = "events.1.jsonl";

/** Size at which the log is rotated, so it never grows without bound. */
export const MAX_EVENTS_BYTES = 5 * 1024 * 1024;

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
 * Once the log reaches `maxBytes` (MAX_EVENTS_BYTES), it is renamed to events.1.jsonl,
 * replacing the one before, and a new log starts. The rename happens under a lock, re-checking the
 * size, so two writers never rotate twice in a row; a writer still appending to the old file only
 * adds to events.1.jsonl.
 *
 * @throws TypeError before writing when the event does not match LatchEvent at runtime (for
 * example a malformed `at`), so every line written can be read back.
 */
export async function appendEvent(stateDir: string, event: LatchEvent, { maxBytes = MAX_EVENTS_BYTES } = {}): Promise<void> {
  const result = LatchEventSchema.safeParse(event);
  if (!result.success) {
    throw new TypeError(`appendEvent: invalid event\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, EVENTS_FILE);
  if ((await sizeOf(path)) >= maxBytes) {
    await withFileLock(`${path}.lock`, async () => {
      if ((await sizeOf(path)) >= maxBytes) await replaceFile(path, join(stateDir, ROTATED_EVENTS_FILE));
    });
  }
  const handle = await open(path, "a+");
  try {
    const { size } = await handle.stat();
    const torn = size > 0 && (await handle.read(Buffer.alloc(1), 0, 1, size - 1)).buffer[0] !== 0x0a;
    await handle.appendFile(`${torn ? "\n" : ""}${JSON.stringify(result.data)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/** Size of the file at `path` in bytes, 0 when it does not exist. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Read the event log, events.1.jsonl and then events.jsonl, and return the newest `limit`
 * events, oldest first (all events when `limit` is omitted). A missing file is empty.
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
  const events: LatchEvent[] = [];
  for (const file of [ROTATED_EVENTS_FILE, EVENTS_FILE]) {
    let handle: FileHandle;
    try {
      handle = await open(join(stateDir, file), "r");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
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
