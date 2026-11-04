import { useEffect, useState } from "react";
import { ChangeDetail, type ChangeActions } from "../components/ChangeDetail";
import { PendingList } from "../components/PendingList";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { ApiUnreachableError, approveChange, rejectChange, type ReviewItem } from "../lib/api";
import { useData } from "../lib/data";
import { sentence } from "../lib/format";
import { navigate } from "../lib/useRoute";

/**
 * The sample queue (lib/mock.ts) while the API is unreachable, under the Vite dev server only.
 * `vite build` sets MODE to "production" whatever NODE_ENV says (DEV follows NODE_ENV), so the
 * condition is constant there and the import and the data are dropped from the bundle.
 */
function useSampleItems(unreachable: boolean): ReviewItem[] | null {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  useEffect(() => {
    if (import.meta.env.MODE === "development" && unreachable) {
      let current = true;
      void import("../lib/mock").then((module) => current && setItems(module.mockReviewItems));
      return () => {
        current = false;
      };
    }
  }, [unreachable]);
  return unreachable ? items : null;
}

/**
 * The review queue. Approve and Reject go to the review API; the queue is then refetched, since
 * the proxy may have queued more changes meanwhile. With no API to talk to, the Vite dev server
 * shows sample data, labeled, with both actions disabled; a real install says the API is down.
 */
export function Review({ selectedId }: { selectedId: string | null }) {
  const { pending, reload } = useData();
  const [announcement, setAnnouncement] = useState("");
  // Decided changes stay hidden while the refetch runs, so they cannot be decided twice.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());

  const unreachable = pending.status === "error" && pending.error instanceof ApiUnreachableError;
  const sampleItems = useSampleItems(unreachable);
  const sample = sampleItems !== null;
  const items: ReviewItem[] = (pending.status === "ready" ? pending.data : (sampleItems ?? [])).filter(
    (item) => !decided.has(item.change.id),
  );
  // An unknown or stale id falls back to the first item, so the selection always exists.
  const selected = items.find((item) => item.change.id === selectedId) ?? items[0];

  /** After a decision: say what happened, select the neighbour, refetch everything. */
  const settle = (id: string, message: string) => {
    const index = items.findIndex((item) => item.change.id === id);
    const next = items[index + 1] ?? items[index - 1];
    setDecided((current) => new Set(current).add(id));
    setAnnouncement(message);
    navigate({ page: "review", id: next?.change.id ?? null });
    reload();
  };

  const name = (id: string) => {
    const change = items.find((item) => item.change.id === id)?.change;
    return change ? `${change.serverId}/${change.toolName}` : id;
  };

  const actions: ChangeActions | undefined =
    pending.status === "ready"
      ? {
          onApprove: async (id) => {
            await approveChange(id);
            settle(id, `Approved ${name(id)}. latch.lock was updated: commit it and open a pull request.`);
          },
          onReject: async (id) => {
            await rejectChange(id);
            settle(id, `Rejected ${name(id)}. The tool stays blocked; latch.lock was not changed.`);
          },
        }
      : undefined;

  return (
    <>
      <PageHeader
        title="Review Queue"
        description="Tool definitions that differ from latch.lock, highest tier first. The proxy blocks tier 2 and 3 until you decide."
      />

      {/*
        The live region stays mounted so screen readers announce each decision; each new message
        rises in inside it (keyed, so it replays per decision).
      */}
      <p aria-live="polite" className={announcement ? "rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success" : "sr-only"}>
        <span key={announcement} className="block motion-safe:animate-[ui-rise_0.3s_ease-out]">
          {announcement}
        </span>
      </p>

      {sample && pending.status === "error" && (
        <div role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          <p className="font-medium text-warning">Showing sample data: the review API is not reachable.</p>
          <p className="mt-1 text-muted-foreground">
            {sentence((pending.error as Error).message)} Start it with <code className="font-mono">pnpm ui</code> or{" "}
            <code className="font-mono">latch review --ui</code>, then refresh. Approve and Reject are disabled until it is running.
          </p>
        </div>
      )}

      {pending.status === "loading" && <LoadingState label="Loading the review queue..." />}
      {pending.status === "error" && !sample && (
        <ErrorState title={unreachable ? "The review API is not running." : "The review queue could not be loaded."} error={pending.error} onRetry={reload} />
      )}

      {pending.status === "ready" && items.length === 0 && (
        <Panel>
          <EmptyState title="Nothing to review">Every tool definition the proxy has seen matches latch.lock.</EmptyState>
        </Panel>
      )}

      {selected && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <PendingList items={items} selectedId={selected.change.id} />
          <ChangeDetail key={selected.change.id} item={selected} actions={actions} />
        </div>
      )}
    </>
  );
}
