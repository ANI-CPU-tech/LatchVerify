import type { LatchEvent } from "@schema/index.js";
import { Select } from "../components/Select";
import { useState } from "react";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, buttonClass } from "../components/ui";
import { MAX_EVENTS } from "../lib/api";
import { useData } from "../lib/data";
import { EVENT_KINDS, dateTime, describeEvent, eventTitle, relativeTime } from "../lib/format";

const PAGE_SIZE = 100;

/** .latch/events.jsonl, newest first, filterable by kind and server. */
export function Audit() {
  const { events, reload } = useData();
  const [kind, setKind] = useState<LatchEvent["kind"] | "">("");
  const [server, setServer] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);

  const log = events.status === "ready" ? events.data : [];
  const servers = [...new Set(log.map((event) => event.serverId))].sort();
  const filtered = log.filter((event) => (kind === "" || event.kind === kind) && (server === "" || event.serverId === server)).reverse();

  return (
    <>
      <PageHeader
        title="Audit Log"
        description={`Every decision the proxy and reviewers made, from .latch/events.jsonl (the newest ${MAX_EVENTS}).`}
      />

      {events.status === "loading" && <LoadingState label="Loading the event log..." />}
      {events.status === "error" && <ErrorState title="The event log could not be loaded." error={events.error} onRetry={reload} />}

      {events.status === "ready" && (
        <Panel
          bodyClassName=""
          title={`${filtered.length} ${filtered.length === 1 ? "event" : "events"}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="audit-kind">
                Event kind
              </label>
              <Select
                id="audit-kind"
                value={kind}
                options={[{ value: "", label: "All events" }, ...EVENT_KINDS.map((value) => ({ value, label: eventTitle(value) }))]}
                onChange={(value) => {
                  setKind(value as LatchEvent["kind"] | "");
                  setShown(PAGE_SIZE);
                }}
              />
              <label className="sr-only" htmlFor="audit-server">
                Server
              </label>
              <Select
                id="audit-server"
                value={server}
                options={[{ value: "", label: "All servers" }, ...servers.map((id) => ({ value: id, label: id }))]}
                onChange={(value) => {
                  setServer(value);
                  setShown(PAGE_SIZE);
                }}
              />
            </div>
          }
        >
          {filtered.length === 0 ? (
            <EmptyState title={log.length === 0 ? "No events yet" : "No events match"}>
              {log.length === 0 ? "The proxy writes here once a client starts a wrapped server." : "Change the filters."}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Event
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Server / tool
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.slice(0, shown).map((event, i) => {
                    const text = describeEvent(event);
                    return (
                      <tr key={`${event.at}-${i}`} className="align-top">
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                          <time dateTime={event.at} title={dateTime(event.at)}>
                            {relativeTime(event.at)}
                          </time>
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={text.tone}>{text.title}</Badge>
                        </td>
                        <td className="break-all px-4 py-2 font-mono text-xs">{text.subject}</td>
                        <td className="px-4 py-2 text-xs">{text.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {filtered.length > shown && (
            <div className="border-t p-3 text-center">
              <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setShown((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, filtered.length - shown)} more
              </button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
