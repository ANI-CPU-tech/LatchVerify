import type { Tier } from "@schema/index.js";

const STYLES: Record<Tier, { label: string; className: string }> = {
  0: { label: "Tier 0 · text only", className: "bg-muted text-muted-foreground" },
  1: { label: "Tier 1 · narrowed", className: "bg-success/15 text-success" },
  2: { label: "Tier 2 · review", className: "bg-warning/15 text-warning" },
  3: { label: "Tier 3 · hard block", className: "bg-destructive/15 text-destructive" },
};

export function TierBadge({ tier }: { tier: Tier }) {
  const style = STYLES[tier];
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}
