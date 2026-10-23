import type { ReviewItem } from "../lib/api";
import { relativeTime } from "../lib/format";
import { href } from "../lib/router";
import { TierBadge } from "./TierBadge";

interface Props {
  items: ReviewItem[];
  selectedId: string;
}

/** The queue as links: each change has its own URL (#/review/<id>). */
export function PendingList({ items, selectedId }: Props) {
  return (
    <nav aria-label="Pending changes">
      <ul className="space-y-2">
        {items.map(({ change }) => {
          const selected = change.id === selectedId;
          return (
            <li key={change.id}>
              <a
                href={href({ page: "review", id: change.id })}
                aria-current={selected ? "true" : undefined}
                className={`block rounded-md border p-3 transition-colors hover:bg-muted/60 ${
                  selected ? "border-primary bg-primary/5 shadow-card" : "bg-card"
                }`}
              >
                <span className="block break-words font-mono text-sm font-semibold">{change.toolName}</span>
                <span className="mt-1.5 block">
                  <TierBadge tier={change.tier} />
                </span>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {change.serverId} · {change.before ? "changed" : "new tool"} · {change.findings.length} findings ·{" "}
                  <time dateTime={change.detectedAt}>{relativeTime(change.detectedAt)}</time>
                </p>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
