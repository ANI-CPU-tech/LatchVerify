import type { CapabilitySet } from "@schema/index.js";
import { capabilityRows } from "../lib/format";

interface Props {
  before: CapabilitySet | null;
  after: CapabilitySet;
}

/** The primary signal: which capabilities moved, not which characters. Approved vs current. */
export function CapabilityDiff({ before, after }: Props) {
  const rows = capabilityRows(before, after);
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Capabilities: previously approved and current definition</caption>
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Capability
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Previously approved
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Current definition
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.group} className={`border-t ${row.changed ? "bg-destructive/5" : ""}`}>
              <th scope="row" className="px-3 py-2 font-normal text-muted-foreground">
                {row.group}
              </th>
              <td className="px-3 py-2 font-mono text-xs">{row.before}</td>
              <td className={`px-3 py-2 font-mono text-xs ${row.changed ? "font-semibold text-destructive" : ""}`}>
                {row.changed && <span className="sr-only">Changed: </span>}
                {row.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
