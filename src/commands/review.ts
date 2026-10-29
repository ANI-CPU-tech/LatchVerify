import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { confirm, isCancel, select } from "@clack/prompts";
import pc from "picocolors";
import { diffHashes } from "../analyze/differ.js";
import type { LockFile, PendingChange } from "../schema/index.js";
import { appendEvent } from "../store/events.js";
import { applyApproval, findRecord, readLockfile, writeLockfile } from "../store/lockfile.js";
import { dequeue, readPending, reviewOrder, updatePending } from "../store/pending.js";
import { defaultReviewer, startUiServer } from "../ui/server.js";
import { plural, printable } from "./text.js";

export interface ReviewOptions {
  /** Open the web UI instead of the terminal flow. */
  ui: boolean;
  port: number;
  /**
   * --ui: when `port` is taken, use a free port instead of failing. For the default port only:
   * a port the user chose (--port, LATCH_UI_PORT) fails rather than silently moving.
   */
  portFallback?: boolean;
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
  /** --ui: the built review UI to serve. Defaults to dist/web of this latchverify install. */
  staticDir?: string;
  /** --ui: opens the review UI's URL. Defaults to the platform's browser opener. */
  openBrowser?: (url: string) => void;
  /** --ui: resolves when the server should stop. Defaults to the first SIGINT or SIGTERM. */
  until?: Promise<void>;
}

/** Where `vite build` puts the review UI, seen from dist/commands/ and from src/commands/. */
const BUILT_UI_DIRS = [new URL("../web/", import.meta.url), new URL("../../dist/web/", import.meta.url)];

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
 * With `ui`, the review API and the built web UI are served on 127.0.0.1:`port` instead and the
 * browser is opened on them; they run until Ctrl+C. Approvals there are recorded as the same
 * reviewer.
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
  if (options.ui) return serveUi(options, lockfilePath, stateDir, say);
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

/** `latch review --ui`: serve the review API and built UI until stopped, opening the browser on it. */
async function serveUi(options: ReviewOptions, lockfilePath: string, stateDir: string, say: (line?: string) => void): Promise<number> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error(`latch review: --port must be a whole number from 0 to 65535, got ${String(options.port)}`);
  }
  const staticDir = options.staticDir ?? BUILT_UI_DIRS.map((url) => fileURLToPath(url)).find((dir) => existsSync(join(dir, "index.html")));
  if (staticDir === undefined || !existsSync(join(staticDir, "index.html"))) {
    throw new Error(
      "latch review --ui: the review UI is not built; run `pnpm build` in the latchverify checkout, or `pnpm ui` to work on it",
    );
  }
  // Read both files first: a malformed one is reported here rather than on the first page load.
  await readLockfile(lockfilePath);
  await readPending(stateDir);

  const reviewer = (options.reviewer ?? defaultReviewer()).trim();
  if (reviewer === "") throw new Error("latch review: no reviewer name; set LATCH_REVIEWER or git config user.email");
  const start = (port: number) => startUiServer({ port, lockfilePath, stateDir, reviewer, staticDir });
  const inUse = (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  let handle;
  try {
    handle = await start(options.port);
  } catch (error) {
    if (!inUse(error)) throw error;
    if (!options.portFallback) {
      throw new Error(
        `latch review: port ${options.port} is in use (often an earlier \`latch review --ui\` that is still running); stop it, or choose another port with --port`,
        { cause: error },
      );
    }
    // Port 0: the OS picks a free port. The browser is opened on the actual URL below.
    handle = await start(0);
    say(pc.yellow(`port ${options.port} is in use (often an earlier \`latch review --ui\` that is still running); using a free port instead`));
  }
  say(`review UI on ${handle.url} (approvals are recorded as ${printable(reviewer)}); press Ctrl+C to stop`);
  (options.openBrowser ?? ((url: string) => openInBrowser(url, say)))(handle.url);

  try {
    await (options.until ?? untilSignal());
  } finally {
    await handle.close();
  }
  say("review UI stopped");
  return 0;
}

/** Resolves on the first SIGINT or SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolveStop) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Opens `url` with the platform's opener, saying where to go if that fails. */
function openInBrowser(url: string, say: (line?: string) => void): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => say(`could not open a browser; open ${url} yourself`));
  child.unref();
}

/** Approve change `id` as it is in the queue now; "gone" when it is no longer there. */
async function approve(lockfilePath: string, stateDir: string, id: string, reviewer: string): Promise<"done" | "gone"> {
  const now = new Date();
  const found: { change?: PendingChange } = {};
  await updatePending(stateDir, async (queue) => {
    found.change = queue.find((entry) => entry.id === id);
    if (found.change === undefined) return queue;
    // latch.lock first: a crash in between leaves the change queued, and approving again is idempotent.
    await writeLockfile(lockfilePath, applyApproval(await readLockfile(lockfilePath), found.change, reviewer, now));
    return dequeue(queue, id);
  });
  const { change } = found;
  if (change === undefined) return "gone";
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
  const found: { change?: PendingChange } = {};
  await updatePending(stateDir, (queue) => {
    found.change = queue.find((entry) => entry.id === id);
    return found.change === undefined ? queue : dequeue(queue, id);
  });
  const { change } = found;
  if (change === undefined) return "gone";
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

/** Characters of the served description shown on a card; the review UI shows all of it. */
const MAX_CARD_DESCRIPTION = 600;

/**
 * One change as a card: tier and what the proxy does about it, the tool, what changed in its
 * definition, the description it now serves, the capability delta and every finding. Strings from the server go through
 * printable(), so they cannot carry terminal escapes.
 */
export function renderChange(change: PendingChange, lock: LockFile): string {
  const colour = change.tier === 3 ? pc.red : change.tier === 2 ? pc.yellow : pc.green;
  const lines = [
    `${colour(`tier ${change.tier} · ${TIER_LABEL[change.tier]}`)}  ${pc.bold(printable(`${change.serverId}/${change.toolName}`))}  ${pc.dim(change.id)}`,
    `  detected  ${change.detectedAt}`,
    `  changed   ${describeDefinitionChange(change)}`,
  ];
  if (change.description !== undefined) {
    const shown = [...change.description];
    const text = shown.length > MAX_CARD_DESCRIPTION ? `${shown.slice(0, MAX_CARD_DESCRIPTION).join("")}…` : change.description;
    lines.push(`  serves    ${pc.dim('"')}${printable(text)}${pc.dim('"')}`);
  }
  if (findRecord(lock, change.serverId, change.toolName)?.hashes.composite === change.after.hashes.composite) {
    lines.push(pc.dim("  note      latch.lock already pins this definition; approving only clears it from the queue"));
  }

  const { gained, lost, loosened } = change.capabilityDelta;
  const delta = [
    // Escape the names before colouring: printable() would turn the colour codes into text.
    gained.length > 0 ? pc.red(`gained ${printable(gained.join(", "))}`) : "",
    loosened.length > 0 ? pc.yellow(`loosened ${printable(loosened.join(", "))}`) : "",
    lost.length > 0 ? pc.green(`lost ${printable(lost.join(", "))}`) : "",
  ].filter(Boolean);
  lines.push(`  delta     ${delta.length > 0 ? delta.join("; ") : pc.dim("no capability change")}`);

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
