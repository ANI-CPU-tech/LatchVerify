import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RejectionSchema, type PendingChange, type Rejection } from "../schema/index.js";
import { writeFileAtomic } from "./replace.js";

/** File name of the rejected definitions inside LATCH_STATE_DIR. */
export const REJECTED_FILE = "rejected.json";

/** Rejections kept; the oldest go first. Each names one exact definition, so old ones rarely matter. */
export const MAX_REJECTIONS = 1_000;

const RejectionListSchema = z.array(RejectionSchema);

/**
 * Read <stateDir>/rejected.json. A missing file (or state directory) is an empty list.
 *
 * @throws Error naming the file when it is not valid JSON or an entry fails RejectionSchema,
 * like readPending: dropping an entry silently would let a rejected definition through.
 */
export async function readRejected(stateDir: string): Promise<Rejection[]> {
  const path = join(stateDir, REJECTED_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const remedy = "fix it, or delete it to forget every rejection";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${(error as Error).message}); ${remedy}`, { cause: error });
  }
  const result = RejectionListSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`${path} is not a valid rejection list; ${remedy}\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  return result.data;
}

/**
 * Validate and write the list atomically as 2-space JSON, creating stateDir if needed. Call it
 * under the queue lock (inside updatePending), as the review commands do, so concurrent
 * decisions do not overwrite each other.
 *
 * @throws Error before touching disk when an entry is invalid.
 */
export async function writeRejected(stateDir: string, rejections: readonly Rejection[]): Promise<void> {
  const result = RejectionListSchema.safeParse(rejections);
  if (!result.success) {
    throw new Error(`refusing to write an invalid rejection list\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  await mkdir(stateDir, { recursive: true });
  await writeFileAtomic(join(stateDir, REJECTED_FILE), `${JSON.stringify(result.data, null, 2)}\n`);
}

/**
 * The list with `change`'s served definition added as rejected at `now`, replacing an earlier
 * rejection of the same definition and dropping the oldest past MAX_REJECTIONS. Pure.
 */
export function addRejection(list: readonly Rejection[], change: PendingChange, now: Date): Rejection[] {
  const rejection: Rejection = {
    serverId: change.serverId,
    toolName: change.toolName,
    composite: change.after.hashes.composite,
    tier: change.tier,
    changeId: change.id,
    rejectedAt: now.toISOString(),
  };
  const kept = list.filter((entry) => !sameDefinition(entry, rejection.serverId, rejection.toolName, rejection.composite));
  return [...kept, rejection].slice(-MAX_REJECTIONS);
}

/** The rejection of exactly this served definition, if a reviewer rejected it. */
export function findRejection(list: readonly Rejection[], serverId: string, toolName: string, composite: string): Rejection | undefined {
  return list.find((entry) => sameDefinition(entry, serverId, toolName, composite));
}

function sameDefinition(entry: Rejection, serverId: string, toolName: string, composite: string): boolean {
  return entry.serverId === serverId && entry.toolName === toolName && entry.composite === composite;
}
