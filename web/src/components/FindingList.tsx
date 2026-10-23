import type { Finding, Severity } from "@schema/index";

const SEVERITY: Record<Severity, string> = {
  critical: "border-destructive/40 bg-destructive/5",
  warn: "border-warning/40 bg-warning/5",
  info: "border-border bg-muted/40",
};

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-destructive",
  warn: "text-warning",
  info: "text-muted-foreground",
};

export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">No findings.</p>;
  }
  return (
    <ul className="space-y-2">
      {findings.map((finding, i) => (
        <li key={i} className={`rounded-md border p-3 ${SEVERITY[finding.severity]}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <span className={SEVERITY_TEXT[finding.severity]}>{finding.severity}</span>
            <span className="text-muted-foreground">{finding.type.replace("_", " ")}</span>
          </div>
          <p className="mt-1 text-sm">{finding.message}</p>
          <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">{finding.evidence}</code>
        </li>
      ))}
    </ul>
  );
}
