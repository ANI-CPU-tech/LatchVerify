import { mockReviewItems } from "./lib/mock";

// Scaffold: renders the hardcoded queue. TODO: load via fetchPending() once the API exists.
const items = mockReviewItems;

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">LatchVerify</h1>
            <p className="text-sm text-muted-foreground">Pending tool changes against latch.lock</p>
          </div>
          <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {items.length} pending
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <p className="text-sm text-muted-foreground">Review screen coming soon.</p>
      </main>
    </div>
  );
}
