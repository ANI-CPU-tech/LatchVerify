import type { ReactNode } from "react";
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

export function ChangeDetail({ item }: { item: ReviewItem }) {
  const { change } = item;
  return (
    <article className="space-y-6 rounded-lg border bg-card p-4 sm:p-6">
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

      <Section title="Description diff">
        <TextDiff parts={item.descriptionDiff} />
      </Section>

      {/* TODO: wire to approveChange / rejectChange from lib/api. */}
      <footer className="flex flex-wrap gap-2 border-t pt-4">
        <button
          type="button"
          disabled
          title="not implemented"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Approve &amp; update latch.lock
        </button>
        <button
          type="button"
          disabled
          title="not implemented"
          className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Reject
        </button>
      </footer>
    </article>
  );
}
