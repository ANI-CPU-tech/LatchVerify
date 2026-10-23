import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { confirm, isCancel, select } from "@clack/prompts";
import pc from "picocolors";
import { diffHashes } from "../analyze/differ.js";
import type { LockFile, PendingChange } from "../schema/index.js";
import { appendEvent } from "../store/events.js";
import { applyApproval, findRecord, readLockfile, writeLockfile } from "../store/lockfile.js";
import { dequeue, readPending, writePending } from "../store/pending.js";
import { defaultReviewer } from "../ui/server.js";
import { plural, printable } from "./text.js";

export interface ReviewOptions {
  /** Open the web UI instead of the terminal flow. */
  ui: boolean;
  port: number;
  lockfilePath: string;
  stateDir: string;
  /** Ask for a decision on each change. Defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
  /** Where answers come from. Defaults to process.stdin. */
  input?: Readable;
  /** Where the review is written. Defaults to process.stdout. */
  output?: Writable;
  /** Who approvals are recorded as. Defaults to defaultReviewer(): LATCH_REVIEWER, git user.email, OS user. */
  reviewer?: string;
}

/**
 * Review order: highest tier first, then oldest first. Use with a stable sort: changes detected
 * together keep their queue order, which is the order the server listed the tools.
 */
export function reviewOrder(a: PendingChange, b: PendingChange): number {
  return b.tier - a.tier || Date.parse(a.detectedAt) - Date.parse(b.detectedAt);
}

/**
 * `latch review`: walk the pending queue in review order. Each change is shown with its tier,
 * what changed in the definition (the queue stores hashes, not text, so segments rather than a
 * text diff), the capability delta and every finding, then decided:
 *
 * - Approve: applyApproval, write latch.lock, then drop the change from the queue and log it.
 *   latch.lock goes first, as in the review API: a crash in between leaves the change queued
 *   and approving again is idempotent. A tier-3 approval needs a second confirmation.
 * - Reject: drop the change from the queue and log it. latch.lock is untouched, so the tool
 *   stays blocked until a definition is approved.
 * - Skip leaves it queued; Quit (or Ctrl+C) stops, keeping every decision made so far.
 *
 * Each decision re-reads latch.lock and the queue first, because a running proxy or the review
 * UI may have changed them. A change gone from the queue by then (resolved elsewhere, or
 * replaced by a newer definition) is not approved: the reviewer has not seen what is there now.
 *
 * Without a terminal (or with `interactive: false`) the queue is only listed.
 *
 * Resolves with 0, or 1 when an approval could not be recorded.
 *
 * @throws when latch.lock or the pending queue is malformed.
 */
export async function runReview(options: ReviewOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const lockfilePath = resolve(options.lockfilePath);
  const stateDir = resolve(options.stateDir);
  let lock = await readLockfile(lockfilePath);
  const queue = (await readPending(stateDir)).sort(reviewOrder);
  if (queue.length === 0) {
    say(pc.green("✔ no pending changes"));
    return 0;
  }

  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) {
    say(pc.bold(`latch review: ${plural(queue.length, "pending change")}, highest tier first`));
    for (const change of queue) say(), say(renderChange(change, lock));
    say();
    say(`decide in a terminal with \`latch review\`, or in the browser with \`latch review --ui\``);
    return 0;
  }

  const reviewer = (options.reviewer ?? defaultReviewer()).trim();
  if (reviewer === "") throw new Error("latch review: no reviewer name; set LATCH_REVIEWER or git config user.email");
  const io = { input: options.input ?? process.stdin, output: out };
  const tally = { approved: 0, rejected: 0, skipped: 0, failed: 0 };
  say(pc.bold(`latch review: ${plural(queue.length, "pending change")}, highest tier first; approvals are recorded as ${printable(reviewer)}`));

  for (const [index, change] of queue.entries()) {
    lock = await readLockfile(lockfilePath);
    say();
    say(pc.dim(`(${index + 1}/${queue.length})`));
    say(renderChange(change, lock));
    const decision = await select({
      message: `Decide on ${printable(`${change.serverId}/${change.toolName}`)}`,
      options: [
        { value: "approve", label: "Approve", hint: "pin this definition in latch.lock" },
        { value: "reject", label: "Reject", hint: "drop it from the queue; the tool stays blocked" },
        { value: "skip", label: "Skip", hint: "decide later" },
        { value: "quit", label: "Quit" },
      ],
      // Holding Enter must never approve a blocked change.
      initialValue: change.tier >= 2 ? "skip" : "approve",
      ...io,
    });
    if (isCancel(decision) || decision === "quit") {
      tally.skipped += queue.length - index;
      break;
    }
    if (decision === "skip") {
      tally.skipped++;
      continue;
    }
    if (decision === "approve" && change.tier === 3) {
      const sure = await confirm({
        message: "This is a hard block: hidden instructions, obfuscation, exec or credential access. Approve it anyway?",
        initialValue: false,
        ...io,
      });
      if (isCancel(sure) || !sure) {
        say(pc.dim("  not approved; left in the queue"));
        tally.skipped++;
        continue;
      }
    }

    try {
      const outcome = decision === "approve" ? await approve(lockfilePath, stateDir, change.id, reviewer) : await reject(stateDir, change.id);
      if (outcome === "gone") {
        say(pc.yellow("  ! no longer in the queue (resolved elsewhere, or replaced by a newer definition); skipped"));
        tally.skipped++;
      } else if (decision === "approve") {
        say(`  ${pc.green("✔")} approved: latch.lock now pins this definition`);
        tally.approved++;
      } else {
        say(`  ${pc.green("✔")} rejected: the tool stays blocked`);
        tally.rejected++;
      }
    } catch (error) {
      say(pc.red(`  ✖ could not record the decision: ${printable(error instanceof Error ? error.message : String(error))}`));
      tally.failed++;
    }
  }

  say();
  say(`approved ${tally.approved}, rejected ${tally.rejected}, skipped ${tally.skipped}${tally.failed > 0 ? pc.red(`, failed ${tally.failed}`) : ""}`);
  if (tally.approved > 0) say(`next: commit ${printable(lockfilePath)} and open a pull request, so the approval is reviewed`);
  return tally.failed > 0 ? 1 : 0;
}

/** Approve change `id` as it is in the queue now; "gone" when it is no longer there. */
async function approve(lockfilePath: string, stateDir: string, id: string, reviewer: string): Promise<"done" | "gone"> {
  const queue = await readPending(stateDir);
  const change = queue.find((entry) => entry.id === id);
  if (change === undefined) return "gone";
  const now = new Date();
  await writeLockfile(lockfilePath, applyApproval(await readLockfile(lockfilePath), change, reviewer, now));
  await writePending(stateDir, dequeue(queue, id));
  await logEvent(stateDir, {
    kind: "approved",
    at: now.toISOString(),
    serverId: change.serverId,
    toolName: change.toolName,
    changeId: id,
    approvedBy: reviewer,
  });
  return "done";
}

/** Reject change `id`; "gone" when it is no longer in the queue. */
async function reject(stateDir: string, id: string): Promise<"done" | "gone"> {
  const queue = await readPending(stateDir);
  const change = queue.find((entry) => entry.id === id);
  if (change === undefined) return "gone";
  await writePending(stateDir, dequeue(queue, id));
  await logEvent(stateDir, { kind: "rejected", at: new Date().toISOString(), serverId: change.serverId, toolName: change.toolName, changeId: id });
  return "done";
}

/** Record an event without failing the decision, which is already saved. */
async function logEvent(stateDir: string, event: Parameters<typeof appendEvent>[1]): Promise<void> {
  try {
    await appendEvent(stateDir, event);
  } catch (error) {
    process.stderr.write(`[latch] could not log the ${event.kind} event: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const TIER_LABEL = ["auto-passed", "auto-passed", "blocked for review", "hard block"] as const;

/**
 * One change as a card: tier and what the proxy does about it, the tool, what changed in its
 * definition, the capability delta and every finding. Strings from the server go through
 * printable(), so they cannot carry terminal escapes.
 */
export function renderChange(change: PendingChange, lock: LockFile): string {
  const colour = change.tier === 3 ? pc.red : change.tier === 2 ? pc.yellow : pc.green;
  const lines = [
    `${colour(`tier ${change.tier} · ${TIER_LABEL[change.tier]}`)}  ${pc.bold(printable(`${change.serverId}/${change.toolName}`))}  ${pc.dim(change.id)}`,
    `  detected  ${change.detectedAt}`,
    `  changed   ${describeDefinitionChange(change)}`,
  ];
  if (findRecord(lock, change.serverId, change.toolName)?.hashes.composite === change.after.hashes.composite) {
    lines.push(pc.dim("  note      latch.lock already pins this definition; approving only clears it from the queue"));
  }

  const { gained, lost, loosened } = change.capabilityDelta;
  const delta = [
    gained.length > 0 ? pc.red(`gained ${gained.join(", ")}`) : "",
    loosened.length > 0 ? pc.yellow(`loosened ${loosened.join(", ")}`) : "",
    lost.length > 0 ? pc.green(`lost ${lost.join(", ")}`) : "",
  ].filter(Boolean);
  lines.push(`  delta     ${delta.length > 0 ? printable(delta.join("; ")) : pc.dim("no capability change")}`);

  if (change.findings.length === 0) {
    lines.push(`  findings  ${pc.dim("none")}`);
  } else {
    lines.push(`  findings`);
    for (const finding of change.findings) {
      const mark = finding.severity === "critical" ? pc.red("✖") : finding.severity === "warn" ? pc.yellow("!") : pc.dim("·");
      const evidence = finding.evidence === "" ? "" : `: ${finding.evidence}`;
      lines.push(`    ${mark} ${pc.dim(`${finding.severity} ${finding.type}`)}  ${printable(`${finding.message}${evidence}`)}`);
    }
  }
  return lines.join("\n");
}

/** "new tool", or which hashed segments differ from the pinned record. */
function describeDefinitionChange(change: PendingChange): string {
  if (change.before === null) return "new tool, not in latch.lock";
  const segments = diffHashes(change.before.hashes, change.after.hashes);
  const changed = [segments.name ? "name" : "", segments.description ? "description" : "", segments.inputSchema ? "input schema" : ""].filter(
    Boolean,
  );
  return changed.length > 0 ? changed.join(", ") : "nothing hashed (capabilities only)";
}
