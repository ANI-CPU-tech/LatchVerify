import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusDot, buttonClass } from "../components/ui";
import { useData } from "../lib/data";
import { dateTime, relativeTime, serverSummaries } from "../lib/format";
import { href } from "../lib/router";

/**
 * Servers from latch.lock, plus any the proxy has logged or queued that are not pinned. Live
 * connection state is not reported anywhere, so this shows the last tools/list the proxy logged.
 */
export function Servers() {
  const { pending, lockfile, events, reload } = useData();
  const lock = lockfile.status === "ready" ? lockfile.data : null;
  const queue = pending.status === "ready" ? pending.data.map((item) => item.change) : [];
  const log = events.status === "ready" ? events.data : [];
  const servers = lock ? serverSummaries(lock, queue, log) : [];

  return (
    <>
      <PageHeader
        title="MCP Servers"
        description="Each server wrapped by latch proxy, as pinned in latch.lock. Status reflects the review queue; last seen is the proxy's last tools/list."
      />
      {lockfile.status === "loading" && <LoadingState label="Loading latch.lock..." />}
      {lockfile.status === "error" && <ErrorState title="latch.lock could not be loaded." error={lockfile.error} onRetry={reload} />}
      {events.status === "error" && (
        <p role="status" className="text-sm text-warning">
          The event log could not be loaded, so last-seen times and blocked calls are missing.
        </p>
      )}
      {lock && servers.length === 0 && (
        <Panel>
          <EmptyState title="No servers pinned">
            Run <code className="font-mono">latch init</code> to wrap your MCP client's servers and pin their tools.
          </EmptyState>
        </Panel>
      )}

      {servers.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {servers.map((server) => (
            <li key={server.id} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card-glass backdrop-blur-sm p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 break-all font-display text-base font-bold">{server.id}</h2>
                <Badge tone={server.status.tone}>
                  <StatusDot tone={server.status.tone} />
                  {server.status.label}
                </Badge>
              </div>
              {server.program !== null ? (
                <p className="text-xs text-muted-foreground">
                  Runs <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">{server.program}</code>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not in latch.lock: every call to it is blocked as unpinned.</p>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Connection</dt>
                  <dd className="font-mono">{server.transport ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Approved tools</dt>
                  <dd className="font-mono">{server.approvedTools}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pending</dt>
                  <dd className={`font-mono ${server.pending > 0 ? "font-semibold text-warning" : ""}`}>{server.pending}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Blocked calls</dt>
                  <dd className={`font-mono ${server.blockedCalls > 0 ? "text-destructive" : ""}`}>{server.blockedCalls}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {server.lastListed ? (
                  <>
                    Last tools/list:{" "}
                    <time dateTime={server.lastListed.at} title={dateTime(server.lastListed.at)}>
                      {relativeTime(server.lastListed.at)}
                    </time>{" "}
                    ({server.lastListed.toolCount} tools)
                  </>
                ) : (
                  "No proxy activity in the event log yet."
                )}
              </p>
              <div className="mt-auto flex flex-wrap gap-2 border-t pt-3">
                {server.firstPendingId && (
                  <a href={href({ page: "review", id: server.firstPendingId })} className={buttonClass("primary", "sm")}>
                    Review {server.pending} {server.pending === 1 ? "change" : "changes"}
                  </a>
                )}
                {server.pinned && (
                  <a href={href({ page: "tools", server: server.id })} className={buttonClass("secondary", "sm")}>
                    View approved tools
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
