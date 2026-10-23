import type { CapabilitySet, LatchEvent, LockFile, PendingChange, Tier, Transport } from "@schema/index.js";

/** Semantic color of a badge, dot or row. Maps to theme tokens in components/ui.tsx. */
export type Tone = "neutral" | "success" | "warning" | "destructive" | "info";

/** What each tier means and what the proxy does with it (src/analyze/tiers.ts). */
export const TIER_INFO: Record<Tier, { label: string; action: string; tone: Tone }> = {
  0: { label: "Text only", action: "auto-passed", tone: "neutral" },
  1: { label: "Narrowed", action: "auto-passed", tone: "success" },
  2: { label: "Needs review", action: "blocked until reviewed", tone: "warning" },
  3: { label: "High risk", action: "hard-blocked", tone: "destructive" },
};

/** Plain words for the capability keys the differ reports (src/analyze/differ.ts). */
const CAPABILITY_WORDS: Record<string, string> = {
  "filesystem.read": "read files",
  "filesystem.write": "write files",
  "filesystem.scope": "reach any file path",
  "exec.enabled": "run programs",
  "exec.shell": "run shell commands",
  "network.egress": "make network requests",
  "network.unconstrained": "reach any URL",
  "credentials.readsEnv": "read environment variables",
  "credentials.readsSecrets": "read secrets",
};

/** "filesystem.read" → "read files"; "network.domains:x.com" → "reach x.com"; unknown keys as is. */
export function capabilityLabel(key: string): string {
  const known = CAPABILITY_WORDS[key];
  if (known !== undefined) return known;
  const [kind, value] = splitOnce(key, ":");
  if (value === undefined) return key;
  if (kind === "network.domains") return `reach ${value}`;
  if (kind === "filesystem.paths") return `access ${value}`;
  if (kind === "crossServerRefs") return `reference tool ${value}`;
  return key;
}

const splitOnce = (text: string, separator: string): [string, string | undefined] => {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
};

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A one-paragraph explanation of a pending change for the reviewer, and the tone to show it in.
 * The tone follows the tier as well as the capabilities: a blocked change never reads as an
 * all-clear just because its capabilities did not move (hidden instructions keep them as is).
 */
export function explainChange(change: PendingChange): { headline: string; details: string[]; tone: Tone } {
  const gained = [...change.capabilityDelta.gained, ...change.capabilityDelta.loosened].map(capabilityLabel);
  const lost = change.capabilityDelta.lost.map(capabilityLabel);
  const critical = change.findings.filter((finding) => finding.severity === "critical").length;
  const tier = TIER_INFO[change.tier];

  const subject = change.before === null ? "This tool is new and was never approved." : "This tool changed since it was approved.";
  const blocked = change.tier >= 2;
  const headline =
    gained.length > 0 ? `It can now ${list(gained)}.`
    : lost.length > 0 && !blocked ? "Its capabilities only narrowed."
    : !blocked ? "Its capabilities did not change."
    : critical > 0 ? `Its capabilities did not change, but its text has ${plural(critical, "critical finding")}.`
    : "Its capabilities did not change, but it still needs review.";
  const tone: Tone = gained.length > 0 || change.tier === 3 ? "destructive" : blocked ? "warning" : "success";
  const details = [subject];
  if (lost.length > 0) details.push(`It can no longer ${list(lost)}.`);
  if (change.findings.length > 0) {
    details.push(`${plural(change.findings.length, "finding")}${critical > 0 ? `, ${critical} critical` : ""}.`);
  }
  details.push(`The proxy ${tier.action} calls to it${change.tier >= 2 ? " until you approve this definition" : ""}.`);
  return { headline, details, tone };
}

/** Short capability tags for a tool, for tables. */
export function capabilityChips(caps: CapabilitySet): string[] {
  const chips: string[] = [];
  const fs = caps.filesystem;
  if (fs.read || fs.write) chips.push(`files: ${[fs.read && "read", fs.write && "write"].filter(Boolean).join("/")} (${fs.scope})`);
  if (caps.exec.enabled) chips.push(caps.exec.shell ? "shell" : "exec");
  if (caps.network.egress) chips.push(caps.network.unconstrained ? "network: any URL" : `network: ${caps.network.domains.join(", ") || "egress"}`);
  if (caps.credentials.readsEnv) chips.push("env vars");
  if (caps.credentials.readsSecrets) chips.push("secrets");
  if (caps.crossServerRefs.length > 0) chips.push(`refs: ${caps.crossServerRefs.join(", ")}`);
  return chips;
}

/** True when a tool can reach exec, credentials, unconstrained files or any URL. */
export function isHighReach(caps: CapabilitySet): boolean {
  return (
    caps.exec.enabled ||
    caps.credentials.readsEnv ||
    caps.credentials.readsSecrets ||
    caps.filesystem.scope === "unconstrained" ||
    caps.network.unconstrained ||
    caps.crossServerRefs.length > 0
  );
}

/** One row of the comparison table: a capability group's approved and current value. */
export interface CapabilityRow {
  group: string;
  before: string;
  after: string;
  changed: boolean;
}

function capabilityValues(caps: CapabilitySet): Array<[string, string]> {
  const fs = caps.filesystem;
  const net = caps.network;
  const flags = (pairs: Array<[boolean | undefined, string]>) =>
    pairs
      .filter(([on]) => on)
      .map(([, name]) => name)
      .join(", ") || "none";
  return [
    ["Filesystem", fs.read || fs.write ? `${flags([[fs.read, "read"], [fs.write, "write"]])} (${fs.scope}${fs.paths.length ? `: ${fs.paths.join(", ")}` : ""})` : "no access"],
    ["Network", net.egress ? (net.unconstrained ? "any URL" : net.domains.join(", ") || "egress") : "no access"],
    ["Shell / exec", caps.exec.enabled ? (caps.exec.shell ? "shell commands" : "programs (argv)") : "no access"],
    ["Credentials", flags([[caps.credentials.readsEnv, "environment"], [caps.credentials.readsSecrets, "secrets"]])],
    ["Cross-server refs", caps.crossServerRefs.join(", ") || "none"],
    [
      "Declared hints",
      flags([
        [caps.declared.readOnlyHint, "readOnly"],
        [caps.declared.destructiveHint, "destructive"],
        [caps.declared.openWorldHint, "openWorld"],
      ]),
    ],
  ];
}

const NOTHING: ReadonlySet<string> = new Set(["no access", "none"]);

/**
 * Approved vs current, one row per capability group. `before` null: the tool was never approved,
 * and a row counts as changed only when the new tool has something in that group.
 */
export function capabilityRows(before: CapabilitySet | null, after: CapabilitySet): CapabilityRow[] {
  const beforeValues = before ? capabilityValues(before) : null;
  return capabilityValues(after).map(([group, value], i) => {
    const previous = beforeValues?.[i]?.[1];
    return {
      group,
      before: previous ?? "not approved",
      after: value,
      changed: previous === undefined ? !NOTHING.has(value) : previous !== value,
    };
  });
}

const EVENT_TITLES: Record<LatchEvent["kind"], string> = {
  tools_listed: "Tool list checked",
  list_changed: "Server announced a change",
  change_detected: "Change detected",
  auto_passed: "Change auto-passed",
  call_blocked: "Call blocked",
  approved: "Change approved",
  rejected: "Change rejected",
};

export const EVENT_KINDS = Object.keys(EVENT_TITLES) as Array<LatchEvent["kind"]>;

export const eventTitle = (kind: LatchEvent["kind"]): string => EVENT_TITLES[kind];

/** The event in words: who, what, and how it should be colored. */
export function describeEvent(event: LatchEvent): { title: string; subject: string; detail: string; tone: Tone } {
  const title = EVENT_TITLES[event.kind];
  switch (event.kind) {
    case "tools_listed":
      return { title, subject: event.serverId, detail: `${plural(event.toolCount, "tool")} listed and analyzed`, tone: "info" };
    case "list_changed":
      return { title, subject: event.serverId, detail: "The proxy re-fetched the tool list", tone: "info" };
    case "change_detected":
      return {
        title,
        subject: `${event.serverId} / ${event.toolName}`,
        detail: `Tier ${event.tier}: ${TIER_INFO[event.tier].action}`,
        tone: TIER_INFO[event.tier].tone,
      };
    case "auto_passed":
      return { title, subject: `${event.serverId} / ${event.toolName}`, detail: `Tier ${event.tier}: ${TIER_INFO[event.tier].label.toLowerCase()}`, tone: "success" };
    case "call_blocked":
      return { title, subject: `${event.serverId} / ${event.toolName}`, detail: event.reason, tone: "destructive" };
    case "approved":
      return { title, subject: `${event.serverId} / ${event.toolName}`, detail: `Approved by ${event.approvedBy}`, tone: "success" };
    case "rejected":
      return { title, subject: `${event.serverId} / ${event.toolName}`, detail: "Rejected; the tool stays blocked", tone: "neutral" };
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; older than 30 days: the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return new Date(then).toISOString().slice(0, 10);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${plural(days, "day")} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** Local date and time for tooltips and tables. */
export const dateTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/** What the UI knows about one server, from latch.lock, the queue and the event log. */
export interface ServerSummary {
  id: string;
  /** False for a server that appears in the queue or log but not in latch.lock. */
  pinned: boolean;
  transport: Transport | null;
  /** Command and args (stdio) or URL (http), as recorded in latch.lock. */
  command: string | null;
  approvedTools: number;
  pending: number;
  highestPendingTier: Tier | null;
  /** First pending change for this server in review order, for "Review" links. */
  firstPendingId: string | null;
  /** The last tools/list the proxy analyzed for this server, if the log has one. */
  lastListed: { at: string; toolCount: number } | null;
  blockedCalls: number;
  status: { label: string; tone: Tone };
}

const quoteArg = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/**
 * Per-server summaries, latch.lock servers first (sorted by id), then servers that only appear
 * in the queue or the event log. `pending` is expected in review order.
 */
export function serverSummaries(lock: LockFile | null, pending: PendingChange[], events: LatchEvent[]): ServerSummary[] {
  const ids = [...Object.keys(lock?.servers ?? {}).sort()];
  for (const id of [...pending.map((c) => c.serverId), ...events.map((e) => e.serverId)].sort()) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => {
    const entry = lock?.servers[id];
    const queued = pending.filter((change) => change.serverId === id);
    const highest = queued.reduce<Tier | null>((max, change) => (max === null || change.tier > max ? change.tier : max), null);
    let lastListed: ServerSummary["lastListed"] = null;
    let blockedCalls = 0;
    for (const event of events) {
      if (event.serverId !== id) continue;
      if (event.kind === "tools_listed") lastListed = { at: event.at, toolCount: event.toolCount };
      if (event.kind === "call_blocked") blockedCalls += 1;
    }
    const status: ServerSummary["status"] =
      highest === 3
        ? { label: "High-risk change", tone: "destructive" }
        : highest !== null
          ? { label: "Review needed", tone: "warning" }
          : entry
            ? { label: "Matches latch.lock", tone: "success" }
            : { label: "Not pinned", tone: "neutral" };
    return {
      id,
      pinned: entry !== undefined,
      transport: entry?.transport ?? null,
      command: entry ? [entry.command, ...entry.args].map(quoteArg).join(" ") : null,
      approvedTools: entry?.tools.length ?? 0,
      pending: queued.length,
      highestPendingTier: highest,
      firstPendingId: queued[0]?.id ?? null,
      lastListed,
      blockedCalls,
      status,
    };
  });
}

/** Number of tools pinned in latch.lock. */
export const approvedToolCount = (lock: LockFile): number => Object.values(lock.servers).reduce((n, server) => n + server.tools.length, 0);

/** The most recent approvedAt in latch.lock, or null for an empty lockfile. */
export function lastApproval(lock: LockFile): { at: string; by: string; tool: string } | null {
  let latest: { at: string; by: string; tool: string } | null = null;
  for (const server of Object.values(lock.servers)) {
    for (const tool of server.tools) {
      if (latest === null || Date.parse(tool.approvedAt) > Date.parse(latest.at)) {
        latest = { at: tool.approvedAt, by: tool.approvedBy, tool: `${tool.serverId} / ${tool.name}` };
      }
    }
  }
  return latest;
}
