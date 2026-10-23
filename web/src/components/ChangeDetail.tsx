import { useState } from "react";
import type { ReviewItem } from "../lib/api";
import { describeError } from "../lib/data";
import { dateTime, explainChange, relativeTime } from "../lib/format";
import { CapabilityDiff } from "./CapabilityDiff";
import { FindingList } from "./FindingList";
import { AlertIcon, CheckIcon } from "./icons";
import { TextDiff } from "./TextDiff";
import { TierBadge } from "./TierBadge";
import { JsonView, Tabs, buttonClass } from "./ui";

const SEGMENTS = [
  ["name", "Name"],
  ["description", "Description"],
  ["inputSchema", "Input schema"],
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
    <ul className="divide-y rounded-md border text-sm">
      {SEGMENTS.map(([key, label]) => {
        const changed = before[key] !== after[key];
        return (
          <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
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

/**
 * One pending change and its review actions. Render it with `key={change.id}` so the busy,
 * confirmation and error state start fresh for every change. Approve and Reject call the review
 * API, which rewrites latch.lock and the queue; nothing here decides what the proxy blocks.
 */
export function ChangeDetail({ item, actions }: { item: ReviewItem; actions?: ChangeActions }) {
  const { change } = item;
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tier 3 is a hard block (hidden instructions, exec or credential access): approving takes two clicks.
  const needsConfirmation = change.tier === 3;
  const explanation = explainChange(change);
  const gained = change.capabilityDelta.gained.length + change.capabilityDelta.loosened.length > 0;

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
    <article aria-busy={busy !== null} className="min-w-0 space-y-5 rounded-lg border bg-card p-4 shadow-card sm:p-6">
      <header className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 break-all font-display text-lg font-bold">
            {change.serverId} / {change.toolName}
          </h2>
          <TierBadge tier={change.tier} />
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{change.id}</span> · detected{" "}
          <time dateTime={change.detectedAt} title={dateTime(change.detectedAt)}>
            {relativeTime(change.detectedAt)}
          </time>
        </p>
      </header>

      <div
        className={`flex gap-3 rounded-md border p-3 text-sm ${
          gained ? "border-destructive/30 bg-destructive/10" : "border-success/30 bg-success/10"
        }`}
      >
        <span className={`mt-0.5 text-base ${gained ? "text-destructive" : "text-success"}`}>{gained ? <AlertIcon /> : <CheckIcon />}</span>
        <div className="space-y-1">
          <p className={`font-semibold ${gained ? "text-destructive" : "text-success"}`}>{explanation.headline}</p>
          <p className="text-foreground">{explanation.details.join(" ")}</p>
        </div>
      </div>

      <Tabs
        label="Change details"
        tabs={[
          {
            id: "capabilities",
            label: "Capabilities",
            content: <CapabilityDiff before={change.before?.capabilities ?? null} after={change.after.capabilities} />,
          },
          { id: "findings", label: `Findings (${change.findings.length})`, content: <FindingList findings={change.findings} /> },
          {
            id: "definition",
            label: "What changed",
            content: item.descriptionDiff ? <TextDiff parts={item.descriptionDiff} /> : <SegmentChanges change={change} />,
          },
          {
            id: "json",
            label: "Raw JSON",
            content: (
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <h3 className="text-xs font-medium text-muted-foreground">Previously approved</h3>
                  {change.before ? <JsonView value={change.before} label="Previously approved record" /> : <p className="text-sm text-muted-foreground">None: new tool.</p>}
                </div>
                <div className="min-w-0 space-y-1">
                  <h3 className="text-xs font-medium text-muted-foreground">Current definition</h3>
                  <JsonView value={change.after} label="Current definition record" />
                </div>
              </div>
            ),
          },
        ]}
      />

      <footer className="space-y-3 border-t pt-4">
        {confirming && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This is a tier 3 change: it was hard-blocked for hidden instructions or exec, credential or cross-server
            access. Approve it only if you have checked every finding.
          </p>
        )}
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={!actions || busy !== null}
            title={actions ? undefined : "Unavailable while showing sample data"}
            className={buttonClass(confirming ? "danger" : "primary")}
          >
            {busy === "approve" ? "Approving..." : confirming ? "Confirm approval" : "Approve & update latch.lock"}
          </button>
          {confirming && busy === null && (
            <button type="button" onClick={() => setConfirming(false)} className={buttonClass("secondary")}>
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
            className={buttonClass("secondary")}
          >
            {busy === "reject" ? "Rejecting..." : "Reject"}
          </button>
        </div>
      </footer>
    </article>
  );
}
