import { ChangeDetail } from "./components/ChangeDetail";
import { PendingList } from "./components/PendingList";
import { mockReviewItems } from "./lib/mock";

// Scaffold: renders the hardcoded queue with the first change selected.
// TODO: load via fetchPending() and keep the selected id in state.
const items = mockReviewItems;
const selected = items[0]!;

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">LatchVerify</h1>
            <p className="text-sm text-muted-foreground">Pending tool changes against latch.lock</p>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {items.length} pending
          </span>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 md:grid-cols-[300px_minmax(0,1fr)]">
        <PendingList items={items} selectedId={selected.change.id} />
        <ChangeDetail item={selected} />
      </main>
    </div>
  );
}
