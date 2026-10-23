import { useEffect, useState } from "react";
import { ChangeDetail, type ChangeActions } from "./components/ChangeDetail";
import { PendingList } from "./components/PendingList";
import { ApiUnreachableError, approveChange, fetchPending, rejectChange, type ReviewItem } from "./lib/api";
import { mockReviewItems } from "./lib/mock";

type QueueState =
  | { status: "loading" }
  /** `source` says whether the items come from the API or are the bundled sample data. */
  | { status: "ready"; items: ReviewItem[]; source: "api" | "mock"; notice?: string }
  | { status: "error"; message: string };

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function App() {
  const [queue, setQueue] = useState<QueueState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    fetchPending(controller.signal)
      .then(
        (items) => {
          if (!controller.signal.aborted) setQueue({ status: "ready", items, source: "api" });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          // Sample data only when there is no API to talk to; a real API error is shown as is.
          setQueue(
            error instanceof ApiUnreachableError
              ? { status: "ready", items: mockReviewItems, source: "mock", notice: error.message }
              : { status: "error", message: describeError(error) },
          );
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [reloads]);

  const reload = () => setReloads((n) => n + 1);
  const items = queue.status === "ready" ? queue.items : [];
  // The selection falls back to the first item, so it always points at something that exists.
  const selected = items.find((item) => item.change.id === selectedId) ?? items[0];

  /**
   * After a change is approved or rejected: drop it, select its neighbour, say what happened,
   * then refetch so the list reflects the API (the proxy may have queued more meanwhile).
   */
  const settle = (id: string, message: string) => {
    const index = items.findIndex((item) => item.change.id === id);
    const next = items[index + 1] ?? items[index - 1];
    setQueue((current) => (current.status === "ready" ? { ...current, items: current.items.filter((item) => item.change.id !== id) } : current));
    setSelectedId(next?.change.id ?? null);
    setAnnouncement(message);
    reload();
  };

  const actions: ChangeActions | undefined =
    queue.status === "ready" && queue.source === "api"
      ? {
          onApprove: async (id) => {
            await approveChange(id);
            const change = items.find((item) => item.change.id === id)?.change;
            settle(id, `Approved ${change?.serverId}/${change?.toolName}. latch.lock was updated: commit it and open a pull request.`);
          },
          onReject: async (id) => {
            await rejectChange(id);
            const change = items.find((item) => item.change.id === id)?.change;
            settle(id, `Rejected ${change?.serverId}/${change?.toolName}. The tool stays blocked; latch.lock was not changed.`);
          },
        }
      : undefined;

  return (
    <div className="min-h-screen">
      <header className="border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">LatchVerify</h1>
            <p className="text-sm text-muted-foreground">Pending tool changes against latch.lock</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {queue.status === "ready" && (
              <span className="whitespace-nowrap rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {items.length} pending
              </span>
            )}
            <button
              type="button"
              onClick={reload}
              disabled={refreshing}
              className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            >
              {refreshing ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        <p aria-live="polite" className={announcement ? "rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm" : "sr-only"}>
          {announcement}
        </p>
        {queue.status === "ready" && queue.source === "mock" && (
          <div role="status" className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
            <p className="font-medium text-warning">Showing sample data: the review API is not reachable.</p>
            <p className="mt-1 text-muted-foreground">
              {queue.notice} Start it with <code className="font-mono">pnpm ui</code>, then refresh. Approve and Reject are
              disabled until it is running.
            </p>
          </div>
        )}

        {queue.status === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the review queue...
          </p>
        )}

        {queue.status === "error" && (
          <div role="alert" className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">The review queue could not be loaded.</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{queue.message}</pre>
            <button type="button" onClick={reload} className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted/50">
              Try again
            </button>
          </div>
        )}

        {queue.status === "ready" && items.length === 0 && (
          <div role="status" className="rounded-lg border bg-card p-6 text-center">
            <p className="font-medium">Nothing to review</p>
            <p className="mt-1 text-sm text-muted-foreground">Every tool definition matches latch.lock.</p>
          </div>
        )}

        {selected && (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-[300px_minmax(0,1fr)]">
            <PendingList items={items} selectedId={selected.change.id} onSelect={setSelectedId} />
            <ChangeDetail key={selected.change.id} item={selected} actions={actions} />
          </div>
        )}
      </main>
    </div>
  );
}
