import type { LatchEvent, LockFile } from "@schema/index.js";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiUnreachableError, fetchEvents, fetchLockfile, fetchLockfileGit, fetchPending, type LockfileGitStatus, type ReviewItem } from "./api";

/**
 * One API resource. While a reload runs, the last data (or error) stays on screen and
 * `refreshing` is true, so the page does not flash back to a loading state.
 */
export type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; refreshing: boolean }
  | { status: "error"; error: unknown; refreshing: boolean };

function useResource<T>(load: (signal: AbortSignal) => Promise<T>, reloadKey: number): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => (current.status === "loading" ? current : { ...current, refreshing: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, refreshing: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error, refreshing: false });
      },
    );
    return () => controller.abort();
    // Only reloadKey triggers a fetch; `load` is a fixed fetcher for this resource.
  }, [reloadKey]);
  return state;
}

export interface AppData {
  pending: Resource<ReviewItem[]>;
  lockfile: Resource<LockFile>;
  events: Resource<LatchEvent[]>;
  git: Resource<LockfileGitStatus>;
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
  const pending = useResource(fetchPending, reloadKey);
  const lockfile = useResource(fetchLockfile, reloadKey);
  const events = useResource((signal) => fetchEvents(undefined, signal), reloadKey);
  const git = useResource(fetchLockfileGit, reloadKey);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const api =
    pending.status === "loading"
      ? "checking"
      : pending.status === "error" && pending.error instanceof ApiUnreachableError
        ? "unreachable"
        : "connected";

  const value: AppData = {
    pending,
    lockfile,
    events,
    git,
    reload,
    busy: [pending, lockfile, events, git].some(isBusy),
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
