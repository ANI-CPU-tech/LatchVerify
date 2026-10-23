import type { Tier } from "@schema/index.js";
import { TIER_INFO } from "../lib/format";
import { Badge } from "./ui";

/** The backend-assigned tier. The UI only displays it; the proxy decides what it blocks. */
export function TierBadge({ tier }: { tier: Tier }) {
  const info = TIER_INFO[tier];
  return (
    <Badge tone={info.tone} className="font-mono">
      Tier {tier} · {info.label}
    </Badge>
  );
}
