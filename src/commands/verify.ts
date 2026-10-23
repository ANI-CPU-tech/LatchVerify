import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { formatCodepoint } from "../analyze/unicode.js";
import { analyzeToolList } from "../proxy/analysis.js";
import { captureTools } from "../proxy/capture.js";
import type { CapabilityDelta, Finding, LockFile, ServerEntry, Tier } from "../schema/index.js";
import { readLockfile } from "../store/lockfile.js";

export interface VerifyOptions {
  lockfilePath: string;
  /** Emit a machine-readable report instead of coloured text. */
  json: boolean;
  /** Deadline for capturing each server's tools. Defaults to DEFAULT_CAPTURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Where the report is written. Defaults to process.stdout. */
  output?: Writable;
}

/** Exit codes, the CI contract. Documented in docs/LOCKFILE.md. */
export const VERIFY_EXIT = {
  ok: 0,
  drift: 1,
  hardBlock: 2,
  error: 3,
} as const;

/** Outcome for one server or the whole run, in increasing severity. */
export type VerifyStatus = "ok" | "drift" | "hard_block" | "error";

const EXIT_FOR: Record<VerifyStatus, number> = {
  ok: VERIFY_EXIT.ok,
  drift: VERIFY_EXIT.drift,
  hard_block: VERIFY_EXIT.hardBlock,
  error: VERIFY_EXIT.error,
};

export interface ToolReport {
  name: string;
  /** "new": listed but not pinned. "removed": pinned but no longer listed (never fails the run). */
  status: "unchanged" | "changed" | "new" | "removed";
  tier?: Tier;
  /** Why the change got its tier. */
  reason?: string;
  capabilityDelta?: CapabilityDelta;
  findings?: Finding[];
}

export interface ServerReport {
  serverId: string;
  command: string;
  args: string[];
  status: VerifyStatus;
  /** Protocol version the server answered with; null when it named none. */
  specVersion?: string | null;
  /** Why the server could not be verified (status "error"). */
  error?: string;
  /** Changed, new and removed tools first, in that order, then unchanged ones; by name within. */
  tools: ToolReport[];
}

export interface VerifyReport {
  lockfile: string;
  status: VerifyStatus;
  exitCode: number;
  /** Why the lockfile itself could not be used. */
  error?: string;
  servers: ServerReport[];
}

/**
 * `latch verify` (CI). For every server in the lockfile, in id order: spawn it, request
 * tools/list, run the proxy's analysis pipeline, and compare each tool with its pinned record.
 * Writes nothing to disk.
 *
 * A server is "hard_block" when any tool changed at tier 3, "drift" when any changed at tier 2 or
 * any listed tool is not pinned (whatever its tier), "error" when it could not be started or
 * spoke invalid JSON-RPC (or uses a transport other than stdio), and "ok" otherwise: tier 0/1
 * changes and tools removed from the server pass. The exit code is that of the worst server
 * (VERIFY_EXIT); a missing or invalid lockfile is an error, so CI can never pass vacuously.
 */
export async function runVerify(options: VerifyOptions): Promise<number> {
  const report = await buildReport(options);
  const output = options.output ?? process.stdout;
  output.write(renderText(report));
  return report.exitCode;
}

async function buildReport(options: VerifyOptions): Promise<VerifyReport> {
  const lockfile = resolve(options.lockfilePath);
  const failed = (error: string): VerifyReport => ({ lockfile, status: "error", exitCode: VERIFY_EXIT.error, error, servers: [] });

  let lock: LockFile;
  try {
    await stat(lockfile);
    lock = await readLockfile(lockfile);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return failed(`no lockfile at ${lockfile}; run \`latch init\` to create one`);
    }
    return failed(error instanceof Error ? error.message : String(error));
  }

  const servers: ServerReport[] = [];
  for (const serverId of Object.keys(lock.servers).sort()) {
    servers.push(await verifyServer(lock, serverId, lock.servers[serverId]!, options.timeoutMs));
  }
  const status = servers.reduce<VerifyStatus>((worst, server) => (EXIT_FOR[server.status] > EXIT_FOR[worst] ? server.status : worst), "ok");
  return { lockfile, status, exitCode: EXIT_FOR[status], servers };
}

async function verifyServer(lock: LockFile, serverId: string, server: ServerEntry, timeoutMs: number | undefined): Promise<ServerReport> {
  const base = { serverId, command: server.command, args: server.args };
  if (server.transport !== "stdio") {
    return { ...base, status: "error", error: `transport "${server.transport}" is not supported; only stdio servers can be verified`, tools: [] };
  }

  let captured;
  try {
    captured = await captureTools(server.command, server.args, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (error) {
    return { ...base, status: "error", error: error instanceof Error ? error.message : String(error), tools: [] };
  }
  const analysis = analyzeToolList(serverId, { tools: captured.tools }, lock, captured.specVersion, new Date())!;

  const changed: ToolReport[] = analysis.changes.map(({ change, reason }) => ({
    name: change.toolName,
    status: change.before === null ? "new" : "changed",
    tier: change.tier,
    reason,
    capabilityDelta: change.capabilityDelta,
    findings: change.findings,
  }));
  const listed = new Set([...analysis.unchanged, ...changed.map((tool) => tool.name)]);
  const removed: ToolReport[] = server.tools.filter((tool) => !listed.has(tool.name)).map((tool) => ({ name: tool.name, status: "removed" }));
  const unchanged: ToolReport[] = analysis.unchanged.map((name) => ({ name, status: "unchanged" }));

  const status: VerifyStatus = changed.some((tool) => tool.tier === 3)
    ? "hard_block"
    : changed.some((tool) => tool.tier === 2 || tool.status === "new")
      ? "drift"
      : "ok";
  const byName = (a: ToolReport, b: ToolReport) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const order = { changed: 0, new: 1, removed: 2, unchanged: 3 } as const;
  const tools = [...changed, ...removed, ...unchanged].sort((a, b) => order[a.status] - order[b.status] || byName(a, b));
  return { ...base, status, specVersion: captured.specVersion, tools };
}

const SUMMARY: Record<VerifyStatus, string> = {
  ok: "every server matches latch.lock",
  drift: "unreviewed changes or unpinned tools; review them with `latch review` and commit latch.lock",
  hard_block: "tier-3 changes (hidden instructions, obfuscation, exec or credential access); do not approve without a close look",
  error: "some servers could not be verified",
};

/** Human-readable report. Every string a server controls is passed through printable(). */
function renderText(report: VerifyReport): string {
  const lines: string[] = [];
  if (report.error !== undefined) {
    lines.push(pc.red(`✖ ${printable(report.error)}`), pc.red(`✖ error (exit ${report.exitCode})`));
    return `${lines.join("\n")}\n`;
  }

  const count = report.servers.length;
  lines.push(pc.bold(`latch verify: ${count} ${count === 1 ? "server" : "servers"} in ${report.lockfile}`));
  for (const server of report.servers) {
    lines.push("", `${pc.bold(printable(server.serverId))}  ${pc.dim(printable([server.command, ...server.args].join(" ")))}`);
    if (server.error !== undefined) {
      lines.push(pc.red(`  ✖ could not verify: ${printable(server.error)}`));
      continue;
    }
    if (server.tools.length === 0) lines.push(pc.dim("  (no tools)"));
    const width = Math.min(32, Math.max(...server.tools.map((tool) => printable(tool.name).length)));
    for (const tool of server.tools) lines.push(...renderTool(tool, width));
  }

  const verdict = `${report.status === "ok" ? "✔" : "✖"} ${report.status.replace("_", " ")} (exit ${report.exitCode}): ${SUMMARY[report.status]}`;
  lines.push("", report.status === "ok" ? pc.green(verdict) : pc.red(verdict));
  return `${lines.join("\n")}\n`;
}

function renderTool(tool: ToolReport, width: number): string[] {
  const name = printable(tool.name).padEnd(width);
  if (tool.status === "unchanged") return [`  ${pc.green("✔")} ${name}  ${pc.dim("unchanged")}`];
  if (tool.status === "removed") return [`  ${pc.dim("-")} ${name}  ${pc.dim("removed from the server")}`];

  const tier = tool.tier!;
  const label = `${tool.status === "new" ? "new, " : ""}tier ${tier}`;
  const blocking = tier >= 2 || tool.status === "new";
  const mark = blocking ? pc.red("✖") : pc.yellow("~");
  const head = `  ${mark} ${name}  ${blocking ? pc.red(label) : pc.yellow(label)}  ${printable(tool.reason ?? "")}`;
  const findings = tool.findings ?? [];
  const critical = findings.filter((finding) => finding.severity === "critical");
  const indent = " ".repeat(width + 6);
  const lines = [head];
  if (findings.length > 0) {
    const others = findings.length - critical.length;
    lines.push(pc.dim(`${indent}${plural(critical.length, "critical finding")}${others > 0 ? `, ${others} other` : ""}`));
  }
  for (const finding of critical.slice(0, 5)) {
    const evidence = finding.evidence === "" ? "" : `: ${finding.evidence}`;
    lines.push(`${indent}${pc.red("·")} ${printable(`${finding.message}${evidence}`)}`);
  }
  if (critical.length > 5) lines.push(pc.dim(`${indent}… ${plural(critical.length - 5, "more critical finding")}`));
  return lines;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Text safe to print on a terminal: control and format characters (escape sequences, bidi
 * overrides, zero-width characters, line separators) become [U+XXXX]. Other Unicode is kept.
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `[${formatCodepoint(char.codePointAt(0)!)}]`);
}
