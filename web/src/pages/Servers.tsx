import type { ClientReport } from "@schema/index.js";
import { useState } from "react";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusDot, buttonClass } from "../components/ui";
import { ServerIcon } from "../components/icons";
import { setClientConnected } from "../lib/api";
import { describeError, useData } from "../lib/data";
import { clientAnswer, clientServerStatus, dateTime, relativeTime, serverSummaries, unclaimedServers, type ServerSummary } from "../lib/format";
import { href } from "../lib/router";

/** One server latch.lock knows, as a card: status, program, counts and links. */
function ServerCard({ server }: { server: ServerSummary }) {
  return (
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
  );
}

/**
 * One MCP client: its answer, files and servers, with Connect or Disconnect. The servers show
 * their program only, never their arguments or env (the API sends neither).
 */
function ClientPanel({ client, summaries, onChanged }: { client: ClientReport; summaries: ReadonlyMap<string, ServerSummary>; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = clientAnswer(client.answer);
  const connected = client.answer === "connected";
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await setClientConnected(client.id, !connected);
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title={
        <>
          {client.name}
          <Badge tone={answer.tone}>
            <StatusDot tone={answer.tone} />
            {answer.label}
          </Badge>
        </>
      }
      icon={<ServerIcon />}
      action={
        <button type="button" onClick={() => void toggle()} disabled={busy} className={buttonClass(connected ? "secondary" : "primary", "sm")}>
          {busy ? (connected ? "Disconnecting..." : "Connecting...") : connected ? "Disconnect" : "Connect"}
        </button>
      }
    >
      <div className="space-y-3">
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {client.files.map((file) => (
            <li key={`${file.path}|${file.scope ?? ""}`} className="break-all font-mono">
              {file.path}
              {file.scope && <span className="font-sans"> ({file.scope})</span>}
            </li>
          ))}
        </ul>
        {!connected && (
          <p className="text-sm text-muted-foreground">
            {client.answer === "unasked" ? "LatchVerify found this client but has not touched it. " : ""}
            Connect it to start its servers behind the latch proxy; their tools are pinned the first time each one runs. Only the command
            and arguments of each entry change; its environment, where API keys live, is never read or written.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {client.problems.map((problem) => (
          <p key={problem} role="status" className="text-sm text-warning">
            {problem}; LatchVerify leaves it unchanged.
          </p>
        ))}
        {client.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stdio servers in this client.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {client.servers.map((server) => {
              const status = clientServerStatus(server, client.answer, summaries.get(server.id));
              const summary = summaries.get(server.id);
              return (
                <li key={server.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-sm font-semibold">{server.id}</span>
                  <span className="text-xs text-muted-foreground">
                    runs <code className="rounded-sm bg-muted px-1 font-mono text-foreground">{server.program}</code>
                  </span>
                  <Badge tone={status.tone} className="ml-auto">
                    <StatusDot tone={status.tone} />
                    {status.label}
                  </Badge>
                  <p className="w-full text-xs text-muted-foreground">
                    {status.detail}
                    {[
                      summary?.firstPendingId ? { label: "Review", to: href({ page: "review", id: summary.firstPendingId }) } : null,
                      server.pin === "pinned" ? { label: "Approved tools", to: href({ page: "tools", server: server.id }) } : null,
                    ]
                      .filter((link) => link !== null)
                      .map((link, i) => (
                        <span key={link.label}>
                          {i === 0 ? " " : " · "}
                          <a className="font-medium text-primary hover:underline" href={link.to}>
                            {link.label}
                          </a>
                        </span>
                      ))}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/**
 * The MCP clients on this machine, each with the servers it starts, and below them any server
 * latch.lock pins that no client here starts (a project's latch.lock, a removed client). Live
 * connection state is not reported anywhere, so cards show the last tools/list the proxy logged.
 */
export function Servers() {
  const { pending, lockfile, events, clients, reload } = useData();
  const lock = lockfile.status === "ready" ? lockfile.data : null;
  const queue = pending.status === "ready" ? pending.data.map((item) => item.change) : [];
  const log = events.status === "ready" ? events.data : [];
  const summaries = lock ? serverSummaries(lock, queue, log) : [];
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const report = clients.status === "ready" ? clients.data : null;
  const others = unclaimedServers(summaries, report);

  return (
    <>
      <PageHeader
        title="MCP Servers"
        description="Every MCP client on this machine and the servers it starts. A connected client's servers run behind the latch proxy."
      />
      {clients.status === "loading" && <LoadingState label="Looking for MCP clients..." />}
      {clients.status === "error" && <ErrorState title="The MCP clients could not be listed." error={clients.error} onRetry={reload} />}
      {report && report.clients.length === 0 && (
        <Panel>
          <EmptyState title="No MCP client found">
            Install an MCP client such as Claude Code, Cursor or VS Code; LatchVerify lists it here and asks before connecting it.
          </EmptyState>
        </Panel>
      )}
      {report && report.clients.length > 0 && (
        <div className="space-y-4">
          {report.clients.map((client) => (
            <ClientPanel key={client.id} client={client} summaries={byId} onChanged={reload} />
          ))}
        </div>
      )}

      {lockfile.status === "error" && <ErrorState title="latch.lock could not be loaded." error={lockfile.error} onRetry={reload} />}
      {events.status === "error" && (
        <p role="status" className="text-sm text-warning">
          The event log could not be loaded, so last-seen times and blocked calls are missing.
        </p>
      )}
      {others.length > 0 && (
        <>
          <h2 className="pt-2 font-display text-base font-bold">Other servers in latch.lock</h2>
          <p className="text-sm text-muted-foreground">Pinned in latch.lock, but no MCP client on this machine starts them.</p>
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {others.map((server) => (
              <ServerCard key={server.id} server={server} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
