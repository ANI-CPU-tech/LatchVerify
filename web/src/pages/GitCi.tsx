import { AlertIcon, CheckIcon, GitIcon, TerminalIcon, ToolCheckIcon } from "../components/icons";
import { Badge, ErrorState, LoadingState, PageHeader, Panel, Terminal } from "../components/ui";
import { CI_SNIPPET, VERIFY_EXIT_CODES } from "../lib/ci";
import { useData } from "../lib/data";
import { approvedToolCount, dateTime, lastApproval, relativeTime } from "../lib/format";

/** latch.lock contents and git state, and the CI contract that enforces it. */
export function GitCi() {
  const { lockfile, git, events, reload } = useData();
  const lock = lockfile.status === "ready" ? lockfile.data : null;
  const latest = lock ? lastApproval(lock) : null;
  const decisions =
    events.status === "ready"
      ? events.data
          .filter((event) => event.kind === "approved" || event.kind === "rejected")
          .slice(-5)
          .reverse()
      : [];

  return (
    <>
      <PageHeader
        title="Git & CI"
        description="Approvals live in latch.lock. They take effect in CI once the file is committed and merged."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="latch.lock" icon={<ToolCheckIcon />}>
          {lockfile.status === "loading" && <LoadingState label="Loading latch.lock..." />}
          {lockfile.status === "error" && <ErrorState title="latch.lock could not be loaded." error={lockfile.error} onRetry={reload} />}
          {lock && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Format version</dt>
                <dd className="font-mono">{lock.version}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Generated</dt>
                <dd>
                  <time dateTime={lock.generatedAt} title={dateTime(lock.generatedAt)}>
                    {relativeTime(lock.generatedAt)}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Servers</dt>
                <dd className="font-mono">{Object.keys(lock.servers).length}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Approved tools</dt>
                <dd className="font-mono">{approvedToolCount(lock)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Latest approval</dt>
                <dd className="break-all">
                  {latest ? (
                    <>
                      <span className="font-mono">{latest.tool}</span> by {latest.by},{" "}
                      <time dateTime={latest.at} title={dateTime(latest.at)}>
                        {relativeTime(latest.at)}
                      </time>
                    </>
                  ) : (
                    "None yet"
                  )}
                </dd>
              </div>
            </dl>
          )}
        </Panel>

        <Panel title="Git status" icon={<GitIcon />}>
          {git.status === "loading" && <LoadingState label="Checking git..." />}
          {git.status === "error" && <ErrorState title="Git status could not be loaded." error={git.error} onRetry={reload} />}
          {git.status === "ready" && !git.data.available && <p className="text-sm text-muted-foreground">Not available: {git.data.reason}.</p>}
          {git.status === "ready" && git.data.available && (
            <div className="space-y-3 text-sm">
              {!git.data.tracked ? (
                <p className="flex items-start gap-2 text-warning">
                  <span className="mt-0.5">
                    <AlertIcon />
                  </span>
                  latch.lock is not committed. CI cannot verify against it until it is.
                </p>
              ) : git.data.modified ? (
                <p className="flex items-start gap-2 text-warning">
                  <span className="mt-0.5">
                    <AlertIcon />
                  </span>
                  latch.lock has uncommitted changes. Commit them and open a pull request so the approval is reviewed.
                </p>
              ) : (
                <p className="flex items-start gap-2 text-success">
                  <span className="mt-0.5">
                    <CheckIcon />
                  </span>
                  latch.lock is committed with no local changes.
                </p>
              )}
              {git.data.lastCommit && (
                <p className="text-muted-foreground">
                  Last commit <code className="font-mono text-foreground">{git.data.lastCommit.hash.slice(0, 7)}</code>{" "}
                  <time dateTime={git.data.lastCommit.date} title={dateTime(git.data.lastCommit.date)}>
                    {relativeTime(git.data.lastCommit.date)}
                  </time>
                  : <span className="text-foreground">{git.data.lastCommit.subject}</span>
                </p>
              )}
              {(git.data.modified || !git.data.tracked) && (
                <Terminal label="Commit command">{`git add latch.lock\ngit commit -m "chore(latch): approve tool changes"`}</Terminal>
              )}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="CI verification" icon={<TerminalIcon />}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3 text-sm">
            <p className="text-muted-foreground">
              <code className="font-mono text-foreground">latch verify</code> connects to every server in latch.lock, fetches its tools and
              fails the job on unreviewed drift. Run it on every pull request and on a schedule. Results appear in your CI logs; this
              page does not run it.
            </p>
            <Terminal label="GitHub Actions steps">{CI_SNIPPET}</Terminal>
          </div>
          <table className="w-full self-start text-left text-sm">
            <caption className="sr-only">latch verify exit codes</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Exit
                </th>
                <th scope="col" className="py-1 font-medium">
                  Meaning
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {VERIFY_EXIT_CODES.map((row) => (
                <tr key={row.code}>
                  <td className="py-2 pr-3 align-top">
                    <Badge tone={row.code === 0 ? "success" : row.code === 2 ? "destructive" : "warning"} className="font-mono">
                      {row.code} {row.status}
                    </Badge>
                  </td>
                  <td className="py-2">{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {decisions.length > 0 && (
        <Panel title="Recent decisions" bodyClassName="">
          <ul className="divide-y">
            {decisions.map((event, i) => (
              <li key={`${event.at}-${i}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <Badge tone={event.kind === "approved" ? "success" : "neutral"}>{event.kind}</Badge>
                <span className="min-w-0 flex-1 break-all font-mono">
                  {event.serverId} / {event.toolName}
                </span>
                <time dateTime={event.at} title={dateTime(event.at)} className="text-xs text-muted-foreground">
                  {relativeTime(event.at)}
                </time>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
