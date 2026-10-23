import type { ReactNode } from "react";
import { AlertIcon, ArrowRightIcon, LogIcon, QueueIcon, ServerIcon, ToolCheckIcon } from "../components/icons";
import { TierBadge } from "../components/TierBadge";
import { Badge, EmptyState, ErrorState, LoadingState, Panel, PanelLink, StatusDot, TONE_TEXT, buttonClass } from "../components/ui";
import { useData, type Resource } from "../lib/data";
import { approvedToolCount, dateTime, describeEvent, relativeTime, serverSummaries, type Tone } from "../lib/format";
import { href } from "../lib/router";
import { useCountUp } from "../lib/useCountUp";

/** One headline number. Shows "—" until its source has loaded, never a made-up value. */
function Metric({ label, value, link, icon, tone = "neutral" }: { label: string; value: number | null; link: string; icon: ReactNode; tone?: Tone }) {
  const shown = useCountUp(value);
  return (
    <a href={link} className="group flex items-center gap-3 rounded-lg border bg-card-glass backdrop-blur-sm p-3 shadow-card transition-colors hover:border-primary/50 sm:p-4">
      <span className={`hidden text-2xl sm:inline ${tone === "neutral" ? "text-accent" : TONE_TEXT[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        {/* Counts up to the value as data arrives; screen readers get the final value only. */}
        <span aria-hidden="true" className={`block font-display text-2xl font-bold tabular-nums ${tone === "neutral" ? "" : TONE_TEXT[tone]}`}>
          {shown ?? "—"}
        </span>
        <span className="sr-only">{value ?? "not loaded"}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
      <span className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:inline">
        <ArrowRightIcon />
      </span>
    </a>
  );
}

const ready = <T,>(resource: Resource<T>): T | null => (resource.status === "ready" ? resource.data : null);

export function Overview() {
  const { pending, lockfile, events, reload } = useData();
  const queue = ready(pending);
  const lock = ready(lockfile);
  const log = ready(events);
  const highRisk = queue?.filter((item) => item.change.tier === 3) ?? [];
  // Only with latch.lock loaded: without it every server would look unpinned.
  const servers = lock ? serverSummaries(lock, (queue ?? []).map((item) => item.change), log ?? []) : [];
  const recent = (log ?? []).slice(-6).reverse();

  return (
    <>
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">MCP tool definitions checked against latch.lock, from this machine's proxy state.</p>
      </header>

      {highRisk.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <span className="text-2xl text-destructive">
            <AlertIcon />
          </span>
          <div className="min-w-0 flex-1 basis-56">
            <p className="font-semibold text-destructive">
              {highRisk.length === 1 ? "1 high-risk change is" : `${highRisk.length} high-risk changes are`} hard-blocked
            </p>
            <p className="text-sm text-foreground">
              {highRisk
                .slice(0, 3)
                .map((item) => `${item.change.serverId}/${item.change.toolName}`)
                .join(", ")}
              {highRisk.length > 3 ? ", ..." : ""}: calls are refused until a reviewer decides.
            </p>
          </div>
          <a href={href({ page: "review", id: highRisk[0]!.change.id })} className={buttonClass("danger")}>
            Review now
            <ArrowRightIcon />
          </a>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Metric label="Pending reviews" value={queue?.length ?? null} link={href({ page: "review", id: null })} icon={<QueueIcon />} tone={queue?.length ? "warning" : "neutral"} />
        <Metric label="High-risk (tier 3) pending" value={queue ? highRisk.length : null} link={href({ page: "review", id: highRisk[0]?.change.id ?? null })} icon={<AlertIcon />} tone={highRisk.length ? "destructive" : "neutral"} />
        <Metric label="Approved tools in latch.lock" value={lock ? approvedToolCount(lock) : null} link={href({ page: "tools", server: null })} icon={<ToolCheckIcon />} />
        <Metric label="Servers in latch.lock" value={lock ? Object.keys(lock.servers).length : null} link={href({ page: "servers" })} icon={<ServerIcon />} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Recent activity" icon={<LogIcon />} action={<PanelLink href={href({ page: "audit" })}>View all</PanelLink>} bodyClassName="">
          {events.status === "loading" && <LoadingState label="Loading events..." />}
          {events.status === "error" && (
            <div className="p-4">
              <ErrorState title="The event log could not be loaded." error={events.error} onRetry={reload} />
            </div>
          )}
          {log && recent.length === 0 && <EmptyState title="No activity yet">The proxy logs here once a client starts a wrapped server.</EmptyState>}
          {recent.length > 0 && (
            <ul className="divide-y">
              {recent.map((event, i) => {
                const text = describeEvent(event);
                return (
                  <li key={`${event.at}-${i}`} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-1.5">
                      <StatusDot tone={text.tone} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium">{text.subject}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {text.title}: {text.detail}
                      </p>
                    </div>
                    <time dateTime={event.at} title={dateTime(event.at)} className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(event.at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Servers" icon={<ServerIcon />} action={<PanelLink href={href({ page: "servers" })}>Manage</PanelLink>} bodyClassName="">
          {lockfile.status === "loading" && <LoadingState label="Loading latch.lock..." />}
          {lockfile.status === "error" && (
            <div className="p-4">
              <ErrorState title="latch.lock could not be loaded." error={lockfile.error} onRetry={reload} />
            </div>
          )}
          {lock && servers.length === 0 && <EmptyState title="No servers pinned">Run latch init to pin your MCP servers.</EmptyState>}
          {servers.length > 0 && (
            <ul className="divide-y">
              {servers.slice(0, 6).map((server) => (
                <li key={server.id}>
                  <a href={href({ page: "tools", server: server.id })} className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium">{server.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {server.transport ?? "not pinned"} · {server.approvedTools} tools
                        {server.lastListed ? ` · seen ${relativeTime(server.lastListed.at)}` : ""}
                      </p>
                    </div>
                    <Badge tone={server.status.tone}>{server.status.label}</Badge>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {queue && queue.length > 0 && (
        <Panel title="Waiting for review" icon={<QueueIcon />} action={<PanelLink href={href({ page: "review", id: null })}>Open queue</PanelLink>} bodyClassName="">
          <ul className="divide-y">
            {queue.slice(0, 5).map(({ change }) => (
              <li key={change.id}>
                <a href={href({ page: "review", id: change.id })} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">
                    {change.serverId} / {change.toolName}
                  </span>
                  <TierBadge tier={change.tier} />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
