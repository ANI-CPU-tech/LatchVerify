import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import pc from "picocolors";
import { diffHashes } from "../analyze/differ.js";
import type { LockFile, PendingChange } from "../schema/index.js";
import { findRecord, readLockfile } from "../store/lockfile.js";
import { readPending } from "../store/pending.js";
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
}

/**
 * Review order: highest tier first, then oldest first. Use with a stable sort: changes detected
 * together keep their queue order, which is the order the server listed the tools.
 */
export function reviewOrder(a: PendingChange, b: PendingChange): number {
  return b.tier - a.tier || Date.parse(a.detectedAt) - Date.parse(b.detectedAt);
}

/**
 * `latch review`: show the pending queue in review order, each change with its tier, what
 * changed in the definition (the queue stores hashes, not text, so segments rather than a text
 * diff), the capability delta and every finding.
 *
 * @throws when latch.lock or the pending queue is malformed.
 */
export async function runReview(options: ReviewOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const stateDir = resolve(options.stateDir);
  const lock = await readLockfile(resolve(options.lockfilePath));
  const queue = (await readPending(stateDir)).sort(reviewOrder);
  if (queue.length === 0) {
    say(pc.green("✔ no pending changes"));
    return 0;
  }

  say(pc.bold(`latch review: ${plural(queue.length, "pending change")}, highest tier first`));
  for (const change of queue) say(), say(renderChange(change, lock));
  say();
  say(`decide in a terminal with \`latch review\`, or in the browser with \`latch review --ui\``);
  return 0;
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
