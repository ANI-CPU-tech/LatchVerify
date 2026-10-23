import { useState } from "react";
import { ChevronRightIcon } from "../components/icons";
import { Badge, EmptyState, ErrorState, JsonView, LoadingState, PageHeader, Panel, inputClass } from "../components/ui";
import { useData } from "../lib/data";
import { capabilityChips, dateTime, isHighReach, relativeTime } from "../lib/format";
import { navigate } from "../lib/useRoute";

/** Every tool pinned in latch.lock, filterable by server and name. Each row expands to its record. */
export function Tools({ server }: { server: string | null }) {
  const { lockfile, reload } = useData();
  const [query, setQuery] = useState("");
  // Rows whose details are open. Details render only while open, so their rise plays on every open
  // (a closed <details> keeps its content in the DOM) and closed rows do not each build a JsonView.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, isOpen: boolean) =>
    setOpen((current) => {
      const next = new Set(current);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });

  const lock = lockfile.status === "ready" ? lockfile.data : null;
  const serverIds = lock ? Object.keys(lock.servers).sort() : [];
  const needle = query.trim().toLowerCase();
  const tools = lock
    ? serverIds
        .filter((id) => server === null || id === server)
        .flatMap((id) => lock.servers[id]!.tools)
        .filter((tool) => needle === "" || tool.name.toLowerCase().includes(needle))
        .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.name.localeCompare(b.name))
    : [];

  return (
    <>
      <PageHeader
        title="Approved Tools"
        description="Tool definitions pinned in latch.lock. The proxy forwards calls only to these exact definitions."
      />

      {lockfile.status === "loading" && <LoadingState label="Loading latch.lock..." />}
      {lockfile.status === "error" && <ErrorState title="latch.lock could not be loaded." error={lockfile.error} onRetry={reload} />}

      {lock && (
        <Panel
          bodyClassName=""
          title={`${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="tool-server">
                Server
              </label>
              <select
                id="tool-server"
                className={inputClass}
                value={server ?? ""}
                onChange={(event) => navigate({ page: "tools", server: event.target.value || null })}
              >
                <option value="">All servers</option>
                {serverIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="tool-search">
                Search tools
              </label>
              <input
                id="tool-search"
                type="search"
                placeholder="Search tools"
                className={`${inputClass} w-40`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          }
        >
          {server !== null && !serverIds.includes(server) && <EmptyState title={`No server "${server}" in latch.lock`} />}
          {tools.length === 0 && (server === null || serverIds.includes(server)) && (
            <EmptyState title={needle ? "No tools match" : "No tools pinned"}>
              {needle ? "Try another name." : <>Run <code className="font-mono">latch init</code> to pin your servers' tools.</>}
            </EmptyState>
          )}
          <ul className="divide-y">
            {tools.map((tool) => {
              const chips = capabilityChips(tool.capabilities);
              const reach = isHighReach(tool.capabilities);
              return (
                <li key={`${tool.serverId}/${tool.name}`}>
                  <details className="group" onToggle={(event) => toggle(`${tool.serverId}/${tool.name}`, event.currentTarget.open)}>
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-200 hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
                      <span className="text-muted-foreground transition-[transform,color] duration-200 ease-out group-open:rotate-90 group-hover:text-foreground">
                        <ChevronRightIcon />
                      </span>
                      <span className="min-w-0 flex-1 basis-48">
                        <span className="block break-all font-mono text-sm font-semibold">{tool.name}</span>
                        <span className="block text-xs text-muted-foreground">{tool.serverId}</span>
                      </span>
                      <span className="flex min-w-0 basis-64 flex-wrap gap-1">
                        {chips.length === 0 ? (
                          <Badge>no capabilities</Badge>
                        ) : (
                          chips.map((chip) => (
                            <Badge key={chip} tone={reach ? "warning" : "neutral"} className="max-w-full truncate">
                              {chip}
                            </Badge>
                          ))
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {tool.approvedBy} ·{" "}
                        <time dateTime={tool.approvedAt} title={dateTime(tool.approvedAt)}>
                          {relativeTime(tool.approvedAt)}
                        </time>
                      </span>
                    </summary>
                    {open.has(`${tool.serverId}/${tool.name}`) && (
                    <div className="space-y-2 px-4 pb-4 motion-safe:animate-[ui-rise_0.25s_ease-out]">
                      <p className="text-xs text-muted-foreground">
                        Composite hash <code className="break-all font-mono">{tool.hashes.composite}</code> · spec {tool.specVersion}
                      </p>
                      <JsonView value={tool} label={`${tool.serverId}/${tool.name} record`} />
                    </div>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </>
  );
}
