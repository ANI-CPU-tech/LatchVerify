import { useEffect, useState } from "react";
import { Select } from "../components/Select";
import { TerminalIcon } from "../components/icons";
import { Badge, ErrorState, LoadingState, PageHeader, Panel, StatusDot, Terminal, buttonClass } from "../components/ui";
import { changePreset, fetchPresets, type Presets } from "../lib/api";
import { describeError, useData } from "../lib/data";

/** Clients a preset can be added to when none is found on this machine. */
const FALLBACK_CLIENTS = [{ value: "claude-code", label: "Claude Code" }];

/**
 * Development mode only (LATCH_DEV=1): add the repository's demo servers to an MCP client in one
 * click, to try LatchVerify against a benign server, a rug pull and poisoned tools. Each preset is
 * added with `latch add`, so it is linked and pinned on its first run like any server; Remove takes
 * it out of the client and latch.lock again. `pnpm demo:add` does the same from a terminal.
 */
export function DevTools() {
  const { clients, reload } = useData();
  const [presets, setPresets] = useState<Presets | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "destructive"; text: string } | null>(null);
  const options = clients.status === "ready" && clients.data.clients.length > 0 ? clients.data.clients.map((client) => ({ value: client.id, label: client.name })) : FALLBACK_CLIENTS;
  const [client, setClient] = useState<string>(options[0]!.value);
  // Follow the client list once it loads: keep the choice if it is still there, else take the first.
  useEffect(() => {
    if (!options.some((option) => option.value === client)) setClient(options[0]!.value);
  }, [options.map((option) => option.value).join(",")]);

  const load = () => {
    fetchPresets().then(
      (data) => {
        setPresets(data);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(error),
    );
  };
  useEffect(load, []);

  const act = async (id: string, action: "add" | "remove") => {
    setBusy(`${id}:${action}`);
    setMessage(null);
    try {
      const text = await changePreset(id, client, action);
      setMessage({ tone: "success", text });
      load();
      reload();
    } catch (error) {
      setMessage({ tone: "destructive", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };
  const clientName = (id: string) => options.find((option) => option.value === id)?.label ?? id;

  return (
    <>
      <PageHeader
        title="Dev Tools"
        description="Development mode only. Add the demo MCP servers to a client to try LatchVerify against a benign server, a rug pull and poisoned tools."
      />
      {loadError !== null && <ErrorState title="The demo presets could not be loaded." error={loadError} onRetry={load} />}
      {presets === null && loadError === null && <LoadingState label="Loading the demo presets..." />}
      {presets !== null && !presets.available && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          The demo servers are not here: this is not a source checkout with demo/ and tsx installed.
        </p>
      )}
      {presets !== null && (
        <Panel
          title="Demo servers"
          icon={<TerminalIcon />}
          action={
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Add to</span>
              <Select id="devtools-client" value={client} options={options} onChange={setClient} size="sm" />
            </label>
          }
        >
          <div className="space-y-4">
            <p aria-live="polite" className={message ? `whitespace-pre-wrap rounded-md border px-3 py-2 text-sm ${message.tone === "success" ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}` : "sr-only"}>
              {message?.text}
            </p>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {presets.presets.map((preset) => {
                const here = preset.clients.includes(client);
                return (
                  <li key={preset.id} className="flex flex-col gap-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-sm font-bold">{preset.name}</h3>
                      <code className="font-mono text-xs text-muted-foreground">{preset.id}</code>
                      {preset.inLockfile && (
                        <Badge tone="success" className="ml-auto">
                          <StatusDot tone="success" />
                          In latch.lock
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{preset.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {preset.clients.length > 0 ? `In ${preset.clients.map(clientName).join(", ")}` : "Not added to any client"}
                    </p>
                    <div className="mt-auto flex gap-2">
                      <button type="button" disabled={!presets.available || here || busy !== null} onClick={() => void act(preset.id, "add")} className={buttonClass("primary", "sm")}>
                        {busy === `${preset.id}:add` ? "Adding..." : `Add to ${clientName(client)}`}
                      </button>
                      <button type="button" disabled={!here || busy !== null} onClick={() => void act(preset.id, "remove")} className={buttonClass("secondary", "sm")}>
                        {busy === `${preset.id}:remove` ? "Removing..." : "Remove"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">Restart the client after adding or removing a server. Each preset is pinned the first time the client starts it.</p>
          </div>
        </Panel>
      )}
      <Panel title="From a terminal">
        <Terminal label="pnpm demo:add">
          {`pnpm demo:add                               # list the presets
pnpm demo:add demo-rugpull --client cursor  # add one
pnpm demo:add demo-rugpull --remove         # remove it from every client`}
        </Terminal>
      </Panel>
    </>
  );
}
