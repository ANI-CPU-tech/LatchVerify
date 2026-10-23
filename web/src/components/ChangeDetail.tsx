import { useState, type ReactNode } from "react";
import type { ReviewItem } from "../lib/api";
import { CapabilityDiff } from "./CapabilityDiff";
import { FindingList } from "./FindingList";
import { TextDiff } from "./TextDiff";
import { TierBadge } from "./TierBadge";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

const SEGMENTS = [
  ["name", "Name"],
  ["description", "Description"],
  ["inputSchema", "Input schema"],
  ["metadata", "Title and annotations"],
] as const;

/**
 * Which parts of the definition changed, from the segment hashes. Live pending changes carry
 * hashes, not text, so this is what the reviewer gets in place of a text diff.
 */
function SegmentChanges({ change }: { change: ReviewItem["change"] }) {
  if (!change.before) {
    return <p className="text-sm text-muted-foreground">New tool: there is no approved definition to compare with.</p>;
  }
  const before = change.before.hashes;
  const after = change.after.hashes;
  return (
    <ul className="space-y-1 text-sm">
      {SEGMENTS.map(([key, label]) => {
        const changed = before[key] !== after[key];
        return (
          <li key={key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5">
            <span>{label}</span>
            <span className={`font-mono text-xs ${changed ? "font-semibold text-warning" : "text-muted-foreground"}`}>
              {changed ? "changed" : "unchanged"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What the reviewer can do with a change. Absent when the screen shows sample data. */
export interface ChangeActions {
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One pending change and its review actions. Render it with `key={change.id}` so the busy,
 * confirmation and error state start fresh for every change.
 */
export function ChangeDetail({ item, actions }: { item: ReviewItem; actions?: ChangeActions }) {
  const { change } = item;
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tier 3 is a hard block (hidden instructions, exec or credential access): approving takes two clicks.
  const needsConfirmation = change.tier === 3;

  const run = async (action: "approve" | "reject") => {
    if (!actions) return;
    setBusy(action);
    setError(null);
    try {
      await (action === "approve" ? actions.onApprove : actions.onReject)(change.id);
    } catch (e) {
      setError(describeError(e));
      setBusy(null);
      setConfirming(false);
    }
  };

  const approve = () => {
    if (needsConfirmation && !confirming) setConfirming(true);
    else void run("approve");
  };

  return (
    <article aria-busy={busy !== null} className="space-y-6 rounded-lg border bg-card p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-all font-mono text-base font-semibold">
            {change.serverId}/{change.toolName}
          </h2>
          <p className="text-xs text-muted-foreground">
            {change.id} · detected {change.detectedAt}
          </p>
        </div>
        <TierBadge tier={change.tier} />
      </header>

      <Section title="Capability diff">
        <CapabilityDiff before={change.before?.capabilities ?? null} after={change.after.capabilities} delta={change.capabilityDelta} />
      </Section>

      <Section title={`Findings (${change.findings.length})`}>
        <FindingList findings={change.findings} />
      </Section>

      {item.descriptionDiff ? (
        <Section title="Description diff">
          <TextDiff parts={item.descriptionDiff} />
        </Section>
      ) : (
        <Section title="What changed">
          <SegmentChanges change={change} />
        </Section>
      )}

      <footer className="space-y-3 border-t pt-4">
        {confirming && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            This is a tier 3 change: it was hard-blocked for hidden instructions or exec, credential or cross-server
            access. Approve it only if you have checked every finding above.
          </p>
        )}
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={!actions || busy !== null}
            title={actions ? undefined : "Unavailable while showing sample data"}
            className={`rounded-md px-4 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 ${
              confirming ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {busy === "approve" ? "Approving..." : confirming ? "Confirm approval" : "Approve & update latch.lock"}
          </button>
          {confirming && busy === null && (
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void run("reject");
            }}
            disabled={!actions || busy !== null}
            title={actions ? undefined : "Unavailable while showing sample data"}
            className="rounded-md border px-4 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting..." : "Reject"}
          </button>
        </div>
      </footer>
    </article>
  );
}
