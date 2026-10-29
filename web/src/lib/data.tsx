import type { LatchEvent, LockFile } from "@schema/index.js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiUnreachableError,
  fetchEvents,
  fetchInfo,
  fetchLockfile,
  fetchLockfileGit,
  fetchPending,
  type ApiInfo,
  type LockfileGitStatus,
  type ReviewItem,
} from "./api";

/**
 * One API resource. While a reload runs, the last data (or error) stays on screen and
 * `refreshing` is true, so the page does not flash back to a loading state.
 */
export type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; refreshing: boolean }
  | { status: "error"; error: unknown; refreshing: boolean };

/** How often the data refetches while the API is connected, in milliseconds. */
const POLL_MS = 3000;

/**
 * A `pollKey` change refetches silently: no `refreshing` flag, and a failure keeps the
 * last state (the next tick retries).
 */
function useResource<T>(load: (signal: AbortSignal) => Promise<T>, reloadKey: number, pollKey: number): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ status: "loading" });
  const lastReloadKey = useRef(reloadKey);
  useEffect(() => {
    const silent = lastReloadKey.current === reloadKey && pollKey > 0;
    lastReloadKey.current = reloadKey;
    const controller = new AbortController();
    if (!silent) setState((current) => (current.status === "loading" ? current : { ...current, refreshing: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, refreshing: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !silent) setState({ status: "error", error, refreshing: false });
      },
    );
    return () => controller.abort();
    // Only the keys trigger a fetch; `load` is a fixed fetcher for this resource.
  }, [reloadKey, pollKey]);
  return state;
}

export interface AppData {
  pending: Resource<ReviewItem[]>;
  lockfile: Resource<LockFile>;
  events: Resource<LatchEvent[]>;
  git: Resource<LockfileGitStatus>;
  /** The API's version and mode. Fetched on load and on reload, not polled: it does not change. */
  info: Resource<ApiInfo>;
  /**
   * Development mode (LATCH_DEV) as the API reports it. False until it answers, and false for an
   * API without /api/info, so demo material never shows by mistake.
   */
  dev: boolean;
  /** Refetches everything: after a decision, or from the Refresh button. */
  reload: () => void;
  /** True while any resource is loading or refreshing. */
  busy: boolean;
  /** "unreachable" when the review API cannot be reached at all. */
  api: "checking" | "connected" | "unreachable";
}

const DataContext = createContext<AppData | null>(null);

const isBusy = (resource: Resource<unknown>): boolean => resource.status === "loading" || resource.refreshing;

export function DataProvider({ children }: { children: ReactNode }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const pending = useResource(fetchPending, reloadKey, pollKey);
  const lockfile = useResource(fetchLockfile, reloadKey, pollKey);
  const events = useResource((signal) => fetchEvents(undefined, signal), reloadKey, pollKey);
  const git = useResource(fetchLockfileGit, reloadKey, pollKey);
  const info = useResource(fetchInfo, reloadKey, 0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const api =
    pending.status === "loading"
      ? "checking"
      : pending.status === "error" && pending.error instanceof ApiUnreachableError
        ? "unreachable"
        : "connected";

  // Poll so a change the proxy queues shows up without a manual Refresh.
  useEffect(() => {
    if (api !== "connected") return;
    const timer = setInterval(() => setPollKey((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [api]);

  const value: AppData = {
    pending,
    lockfile,
    events,
    git,
    info,
    dev: info.status === "ready" && info.data.dev,
    reload,
    busy: [pending, lockfile, events, git, info].some(isBusy),
    api,
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): AppData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useData must be used inside <DataProvider>");
  return value;
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
