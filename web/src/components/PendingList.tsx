import type { ReviewItem } from "../lib/api";
import { TierBadge } from "./TierBadge";

interface Props {
  items: ReviewItem[];
  selectedId: string;
}

export function PendingList({ items, selectedId }: Props) {
  return (
    <nav aria-label="Pending changes">
      <ul className="space-y-2">
        {items.map(({ change }) => {
          const selected = change.id === selectedId;
          return (
            <li key={change.id}>
              {/* TODO: select this change on click once App holds selection state. */}
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                  selected ? "border-primary/50 bg-muted/60" : "bg-card"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="break-all font-mono text-sm font-medium">{change.toolName}</span>
                  <TierBadge tier={change.tier} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {change.serverId} · {change.before ? "changed" : "new tool"} · {change.findings.length} findings
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
