import type { Finding, Severity } from "@schema/index.js";
import type { Tone } from "../lib/format";
import { Badge } from "./ui";

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "destructive",
  warn: "warning",
  info: "neutral",
};

export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">No findings.</p>;
  }
  return (
    <ul className="divide-y rounded-md border">
      {findings.map((finding, i) => (
        <li key={i} className="space-y-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[finding.severity]} className="uppercase">
              {finding.severity}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{finding.type.replace("_", " ")}</span>
          </div>
          <p className="text-sm">{finding.message}</p>
          <code className="block break-all rounded-sm bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{finding.evidence}</code>
        </li>
      ))}
    </ul>
  );
}
