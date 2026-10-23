import { FlaskIcon } from "../components/icons";
import { PageHeader, Panel } from "../components/ui";

/** A rug pull rehearsed with the proxy's own analysis, in memory. */
export function Simulation() {
  return (
    <>
      <PageHeader
        title="Simulation"
        description="Rehearse a rug pull with the proxy's own analysis. It runs in memory: nothing is written to latch.lock, the review queue or the audit log."
      />
      <Panel title="The attack" icon={<FlaskIcon />}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>A weather server with two read-only tools is reviewed and pinned.</li>
          <li>The agent calls it a few times. Every call is forwarded.</li>
          <li>The server swaps its definitions and announces tools/list_changed.</li>
          <li>The proxy analyzes the new list against latch.lock.</li>
          <li>The agent calls the poisoned tool. The proxy answers with an error instead.</li>
        </ol>
      </Panel>
    </>
  );
}
