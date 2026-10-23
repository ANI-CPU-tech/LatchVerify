import type { CapabilityDelta, CapabilitySet } from "@schema/index.js";

const LABELS: Record<string, string> = {
  "filesystem.read": "filesystem read",
  "filesystem.write": "filesystem write",
  "exec.enabled": "exec",
  "exec.shell": "shell exec",
  "network.egress": "network egress",
  "network.unconstrained": "any URL",
  "credentials.readsEnv": "env vars",
  "credentials.readsSecrets": "secrets",
};

const label = (key: string) => LABELS[key] ?? key;

/** One display row per capability group: before value vs after value. */
function rows(caps: CapabilitySet | null): Array<[string, string]> {
  if (!caps) return [["Filesystem", "—"], ["Exec", "—"], ["Network", "—"], ["Credentials", "—"], ["Declared", "—"]];
  const fs = caps.filesystem;
  const net = caps.network;
  const flags = (pairs: Array<[boolean | undefined, string]>) =>
    pairs.filter(([on]) => on).map(([, name]) => name).join(", ") || "none";
  return [
    ["Filesystem", fs.read || fs.write ? `${flags([[fs.read, "read"], [fs.write, "write"]])} · ${fs.scope}` : "none"],
    ["Exec", caps.exec.enabled ? (caps.exec.shell ? "shell" : "argv") : "none"],
    ["Network", net.egress ? (net.unconstrained ? "any URL" : net.domains.join(", ") || "egress") : "none"],
    ["Credentials", flags([[caps.credentials.readsEnv, "env"], [caps.credentials.readsSecrets, "secrets"]])],
    [
      "Declared",
      flags([
        [caps.declared.readOnlyHint, "readOnly"],
        [caps.declared.destructiveHint, "destructive"],
        [caps.declared.openWorldHint, "openWorld"],
      ]),
    ],
  ];
}

interface Props {
  before: CapabilitySet | null;
  after: CapabilitySet;
  delta: CapabilityDelta;
}

/** The primary signal: which capabilities moved, not which characters. */
export function CapabilityDiff({ before, after, delta }: Props) {
  const gained = delta.gained.map(label);
  if (delta.loosened.includes("filesystem.scope")) gained.push(after.filesystem.scope);
  const beforeRows = rows(before);
  const afterRows = rows(after);

  return (
    <div className="space-y-3">
      {gained.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">
          ⚠ New capability: {gained.join(", ")}
        </div>
      ) : (
        <div className="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm font-medium text-success">
          ✓ Capability set unchanged
        </div>
      )}
      {delta.lost.length > 0 && (
        <p className="text-sm text-muted-foreground">Narrowed: {delta.lost.map(label).join(", ")}</p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Capability</th>
              <th className="px-3 py-2 font-medium">Approved</th>
              <th className="px-3 py-2 font-medium">Observed</th>
            </tr>
          </thead>
          <tbody>
            {afterRows.map(([name, value], i) => {
              const previous = beforeRows[i]?.[1];
              const changed = previous !== value;
              return (
                <tr key={name} className="border-t">
                  <td className="px-3 py-2 text-muted-foreground">{name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{previous}</td>
                  <td className={`px-3 py-2 font-mono text-xs ${changed ? "font-semibold text-destructive" : ""}`}>
                    {value}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
