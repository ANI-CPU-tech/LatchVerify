import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SUPPORTED_CLIENTS, clientLocations, type ProxyLaunch } from "../config/clients.js";
import type { Logger } from "../log.js";
import { LatchEventSchema, type LatchEvent, type PendingChange, type Settings } from "../schema/index.js";
import { EVENTS_FILE } from "../store/events.js";
import { PENDING_FILE, readPending } from "../store/pending.js";
import { readSettings } from "../store/settings.js";
import { callsBlocked, changeQueued, pendingSummary, type Notifier } from "./notify.js";
import { syncClients, type SyncResult } from "./sync.js";

export interface WatchOptions {
  lockfilePath: string;
  stateDir: string;
  settingsPath: string;
  reviewer: string;
  log: Logger;
  /** Where notifications go; undefined means the desktop has none (they are logged instead). */
  notify: Notifier | undefined;
  launch?: ProxyLaunch;
  timeoutMs?: number;
  /** Quiet time after the last config change before syncing. */
  debounceMs?: number;
  /** Full sync interval, which also finds clients installed after the watcher started. */
  pollMs?: number;
  /** Window in which repeated blocks of one tool make one notification. */
  blockWindowMs?: number;
  /** Called after every sync, for the app and tests. */
  onSync?: (result: SyncResult) => void;
}

export interface Watcher {
  /** Runs a sync now (after any running one) and resolves with its result. */
  syncNow(): Promise<SyncResult>;
  close(): Promise<void>;
}

export const DEFAULT_DEBOUNCE_MS = 1000;
export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_BLOCK_WINDOW_MS = 60_000;

/** The single-instance marker in the state directory, holding the watcher's pid. */
export const WATCH_PID_FILE = "watch.pid";

/** Another watcher is running for this state directory. */
export class AlreadyWatchingError extends Error {
  override readonly name = "AlreadyWatchingError";
}

/** True while process `pid` exists (signal 0 only checks). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Markers this process holds: its own pid in a marker is live only when it is in here. */
const claimed = new Set<string>();

/** Claims the state directory for this watcher; a marker left by a dead watcher is taken over. */
async function claim(stateDir: string): Promise<string> {
  const path = join(stateDir, WATCH_PID_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      claimed.add(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      const live = pid === process.pid ? claimed.has(path) : Number.isInteger(pid) && alive(pid);
      if (live) throw new AlreadyWatchingError(`latch watch is already running (pid ${pid})`);
      await rm(path, { force: true });
    }
  }
  throw new AlreadyWatchingError(`could not claim ${path}`);
}

/**
 * The background sync: keeps every enabled client linked to latch.lock and tells the user about
 * changes waiting for review and blocked calls. `latch watch` runs it without a window; the desktop
 * app runs it in its own process.
 *
 * - Syncs at start (syncClients), then DEBOUNCE ms after any change in a folder holding a client
 *   config or settings.json, and every POLL ms, which also covers clients installed later and
 *   folders that did not exist at start. Syncs never overlap; a change during one runs one more.
 * - At start, with notifications on, shows how many changes wait for review (pendingSummary).
 * - When a proxy queues a change (pending.json gains an id), shows changeQueued.
 * - When a proxy blocks a call (events.jsonl gains call_blocked), shows callsBlocked; repeats for
 *   one tool within BLOCK_WINDOW ms make one notification with a count. Only the bytes appended
 *   since the last read are read.
 *
 * Only folders are watched, never polled, so an idle watcher costs one inotify watch per folder.
 * At most one watcher runs per state directory (WATCH_PID_FILE); a second throws
 * AlreadyWatchingError.
 */
export async function startWatcher(options: WatchOptions): Promise<Watcher> {
  const { log } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const blockWindowMs = options.blockWindowMs ?? DEFAULT_BLOCK_WINDOW_MS;
  await mkdir(options.stateDir, { recursive: true });
  const marker = await claim(options.stateDir);
  let settings: Settings = await readSettings(options.settingsPath);

  const notify = async (title: string, message: { title: string; body: string; urgency: "normal" | "critical" }) => {
    if (!settings.notifications) return;
    if (options.notify === undefined) {
      log.info(`${title}: ${message.title}. ${message.body}`);
      return;
    }
    await options.notify(message);
  };

  // --- syncing ---
  let running: Promise<SyncResult> | undefined;
  let again = false;
  const runSync = async (): Promise<SyncResult> => {
    try {
      settings = await readSettings(options.settingsPath);
    } catch (error) {
      log.warn(`${(error as Error).message}; keeping the settings read before`);
    }
    const result = await syncClients({
      lockfilePath: options.lockfilePath,
      stateDir: options.stateDir,
      settings,
      reviewer: options.reviewer,
      ...(options.launch === undefined ? {} : { launch: options.launch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    report(result);
    options.onSync?.(result);
    return result;
  };
  const syncNow = (): Promise<SyncResult> => {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = runSync()
      .catch((error: unknown) => {
        log.error(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
        return { problems: [], skipped: [], pinned: [], failed: [], wrapped: [] } satisfies SyncResult;
      })
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          void syncNow();
        }
      });
    return running;
  };
  const report = (result: SyncResult) => {
    for (const pinned of result.pinned) {
      log.info(`pinned ${pinned.serverId}: ${pinned.tools.length} tool(s)${pinned.held.length > 0 ? `, ${pinned.held.length} held for review` : ""}`);
    }
    for (const wrapped of result.wrapped) log.info(`linked ${wrapped.serverIds.join(", ")} in ${wrapped.path}${wrapped.scope === undefined ? "" : ` (${wrapped.scope})`}`);
    for (const failure of result.failed) log.warn(`${failure.serverId}: ${failure.reason}`);
    for (const skip of result.skipped) log.warn(`skipped ${skip.serverId}: ${skip.reason}`);
    for (const problem of result.problems) log.warn(`${problem.path} ${problem.message}; left unchanged`);
  };

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), debounceMs);
  };

  // --- watching folders ---
  const watchers = new Map<string, FSWatcher>();
  /** Folder -> file names in it whose change matters. */
  const interest = new Map<string, Set<string>>();
  const want = (path: string) => {
    const dir = dirname(path);
    if (!interest.has(dir)) interest.set(dir, new Set());
    interest.get(dir)!.add(basename(path));
  };
  for (const client of SUPPORTED_CLIENTS) for (const location of clientLocations(client)) want(location.path);
  want(options.settingsPath);

  const onFolderChange = (dir: string, file: string | null) => {
    if (dir === options.stateDir) {
      if (file === PENDING_FILE) void checkPending();
      else if (file === EVENTS_FILE) void checkEvents();
      return;
    }
    // A null name (some platforms) or a file of interest: resync.
    if (file === null || interest.get(dir)?.has(file)) schedule();
  };
  const arm = () => {
    for (const dir of [...interest.keys(), options.stateDir]) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: true }, (_event, file) => onFolderChange(dir, file === null ? null : String(file)));
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // The folder does not exist yet (client not installed); the poll arms it later.
      }
    }
  };

  // --- pending changes ---
  let known: Set<string> = new Set();
  const checkPending = async () => {
    let queue: PendingChange[];
    try {
      queue = await readPending(options.stateDir);
    } catch {
      return; // mid-write or damaged: the next change event reads it again
    }
    const added = queue.filter((change) => !known.has(change.id));
    known = new Set(queue.map((change) => change.id));
    for (const change of added) await notify("change queued", changeQueued(change));
  };

  // --- blocked calls ---
  const eventsPath = join(options.stateDir, EVENTS_FILE);
  let offset = await stat(eventsPath).then((info) => info.size, () => 0);
  let partial = "";
  const recent = new Map<string, { count: number; timer: NodeJS.Timeout; event: Extract<LatchEvent, { kind: "call_blocked" }> }>();
  const checkEvents = async () => {
    let size: number;
    try {
      size = (await stat(eventsPath)).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = 0; // rotated to events.1.jsonl: the new file starts empty
      partial = "";
    }
    if (size === offset) return;
    const handle = await open(eventsPath, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      text = partial + buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    offset = size;
    const lines = text.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      let event: LatchEvent;
      try {
        event = LatchEventSchema.parse(JSON.parse(line));
      } catch {
        continue;
      }
      if (event.kind === "call_blocked") blocked(event);
    }
  };
  const blocked = (event: Extract<LatchEvent, { kind: "call_blocked" }>) => {
    const key = `${event.serverId}\0${event.toolName}`;
    const seen = recent.get(key);
    if (seen !== undefined) {
      seen.count++;
      seen.event = event;
      return;
    }
    // The first block shows at once; more within the window are summed up when it closes.
    void notify("call blocked", callsBlocked(event));
    const entry = {
      count: 0,
      event,
      timer: setTimeout(() => {
        recent.delete(key);
        if (entry.count > 0) void notify("call blocked", callsBlocked(entry.event, entry.count));
      }, blockWindowMs),
    };
    recent.set(key, entry);
  };

  // --- start ---
  arm();
  await syncNow();
  const queue = await readPending(options.stateDir).catch(() => [] as PendingChange[]);
  known = new Set(queue.map((change) => change.id));
  const summary = pendingSummary(queue);
  if (summary !== undefined) await notify("waiting for review", summary);
  const poll = setInterval(() => {
    arm();
    void syncNow();
  }, pollMs);

  return {
    syncNow,
    close: async () => {
      clearInterval(poll);
      clearTimeout(timer);
      for (const entry of recent.values()) clearTimeout(entry.timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await running;
      claimed.delete(marker);
      await rm(marker, { force: true });
    },
  };
}
