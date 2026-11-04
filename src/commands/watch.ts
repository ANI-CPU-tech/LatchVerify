import { resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { desktopNotifier } from "../daemon/notify.js";
import { syncClients, type SyncResult } from "../daemon/sync.js";
import { startWatcher } from "../daemon/watch.js";
import type { LogLevel } from "../config/env.js";
import { createLogger } from "../log.js";
import { readSettings, settingsPath as defaultSettingsPath } from "../store/settings.js";
import { configPlace, printable } from "./text.js";

export interface WatchCommandOptions {
  lockfilePath: string;
  stateDir: string;
  /** settings.json; defaults to the one beside the per-user lockfile. */
  settingsPath?: string;
  /** Sync once, print what changed and exit, instead of watching. */
  once: boolean;
  /** Desktop notifications (they also follow settings.json); false logs them instead. */
  notify: boolean;
  logLevel: LogLevel;
  output?: Writable;
  /** Resolves when watching should stop. Defaults to the first SIGINT or SIGTERM. */
  until?: Promise<void>;
}

/** A sync's outcome as lines for people. */
export function describeSync(result: SyncResult): string[] {
  const lines: string[] = [];
  for (const id of result.linked) lines.push(`${pc.green("✔")} added ${printable(id)} to latch.lock; its tools are pinned the first time it runs`);
  for (const wrapped of result.wrapped) {
    lines.push(`${pc.green("✔")} linked ${printable(wrapped.serverIds.join(", "))} in ${configPlace(wrapped)}`);
  }
  for (const failure of result.failed) lines.push(pc.red(`✖ ${printable(failure.serverId)}: ${printable(failure.reason)}`));
  for (const skip of result.skipped) lines.push(pc.yellow(`! skipped ${printable(skip.serverId)}: ${printable(skip.reason)}`));
  for (const problem of result.problems) lines.push(pc.yellow(`! ${problem.client}: ${printable(problem.path)} ${printable(problem.message)}; left unchanged`));
  return lines;
}

/**
 * `latch watch`: keep every MCP client linked to latch.lock in the background (see startWatcher),
 * with desktop notifications for changes to review and blocked calls. With --once, sync a single
 * time and exit: 0 when everything was handled, 1 when anything failed or was skipped.
 */
export async function runWatch(options: WatchCommandOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const lockfilePath = resolve(options.lockfilePath);
  const stateDir = resolve(options.stateDir);
  const settingsPath = options.settingsPath ?? defaultSettingsPath();

  if (options.once) {
    const result = await syncClients({ lockfilePath, stateDir, settings: await readSettings(settingsPath) });
    const lines = describeSync(result);
    for (const line of lines) say(line);
    if (lines.length === 0) say("every MCP client is linked; nothing to change");
    return result.failed.length + result.skipped.length + result.problems.length > 0 ? 1 : 0;
  }

  const log = createLogger(options.logLevel);
  const notify = options.notify ? desktopNotifier() : undefined;
  if (options.notify && notify === undefined) log.warn("this desktop has no notifier (notify-send on Linux); notifications are logged here instead");
  const watcher = await startWatcher({ lockfilePath, stateDir, settingsPath, log, notify });
  say(`latch watch: keeping MCP clients linked to ${printable(lockfilePath)}; press Ctrl+C to stop`);
  await (options.until ??
    new Promise<void>((done) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
    }));
  await watcher.close();
  return 0;
}
