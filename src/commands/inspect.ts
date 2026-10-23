import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import pc from "picocolors";
import { analyzeToolList } from "../proxy/analysis.js";
import { captureTools } from "../proxy/capture.js";
import type { CapabilitySet, DeclaredAnnotations, Finding, Tier } from "../schema/index.js";
import { emptyLockfile } from "../store/lockfile.js";
import { plural, printable } from "./text.js";

export interface InspectOptions {
  /** Path to a JSON file containing a tools/list result; mutually exclusive with `server`. */
  file?: string;
  /** Command line of a live server to query instead. */
  server?: string[];
  json: boolean;
  /** Deadline for capturing a live server's tools. Defaults to DEFAULT_CAPTURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Where the report is written. Defaults to process.stdout. */
  output?: Writable;
}

/** Exit codes, matching `latch verify`: 2 means latch would hard-block a tool. */
export const INSPECT_EXIT = {
  ok: 0,
  hardBlock: 2,
  error: 3,
} as const;

export type InspectStatus = "ok" | "hard_block" | "error";

export interface InspectedTool {
  name: string;
  /** Tier the proxy would give this tool the first time it sees it (no pinned record). */
  tier: Tier;
  /** Why it gets that tier. */
  reason: string;
  /** Derived capability set, with the server's annotation claims under `declared`. */
  capabilities: CapabilitySet;
  findings: Finding[];
}

/** Format version of the --json report; bumped on incompatible changes. */
export const INSPECT_REPORT_VERSION = 1;

/** The --json report. Strings are as the tools carried them; JSON escaping keeps them inert. */
export interface InspectReport {
  version: typeof INSPECT_REPORT_VERSION;
  /** Where the tools came from: a file (absolute path) or a server command line. */
  source: { file: string } | { command: string[] };
  /** Protocol version a live server answered with; null for a file or when it named none. */
  specVersion: string | null;
  status: InspectStatus;
  exitCode: number;
  /** Why the tools could not be loaded. */
  error?: string;
  /** List entries skipped because they have no usable name. */
  ignored: number;
  /** In list order, one per tool name. */
  tools: InspectedTool[];
}

/**
 * `latch inspect`: what latch would think of a server, without pinning anything. Loads tools
 * from `file` (a tools/list result, a whole JSON-RPC response, or a bare array of tools) or by
 * spawning `server`, runs the proxy's analysis pipeline as if every tool were new, and prints
 * each tool's derived capabilities, declared annotations, detector findings, and the tier the
 * proxy would give it when it first appears.
 *
 * Read-only: nothing is written to disk and the lockfile is never read.
 *
 * Resolves with INSPECT_EXIT: 2 when any tool would be tier 3 (a hard block: hidden instructions,
 * obfuscation, exec or credential access), 3 when the tools cannot be loaded or the options are
 * wrong, 0 otherwise. Tier 2 is not a failure: every capability is new to an empty lockfile.
 *
 * With `json`, the output is exactly one InspectReport document.
 */
export async function runInspect(options: InspectOptions): Promise<number> {
  const report = await buildReport(options);
  (options.output ?? process.stdout).write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return report.exitCode;
}

async function buildReport(options: InspectOptions): Promise<InspectReport> {
  const server = options.server !== undefined && options.server.length > 0 ? options.server : undefined;
  const source: InspectReport["source"] =
    options.file !== undefined ? { file: resolve(options.file) } : { command: server ?? [] };
  const failed = (error: string): InspectReport => ({
    version: INSPECT_REPORT_VERSION,
    source,
    specVersion: null,
    status: "error",
    exitCode: INSPECT_EXIT.error,
    error,
    ignored: 0,
    tools: [],
  });

  if ((options.file === undefined) === (server === undefined)) {
    return failed("give either --file <path> or a server command after --, not both");
  }

  let tools: unknown[];
  let specVersion: string | null = null;
  try {
    if (options.file !== undefined) {
      tools = await loadToolsFile(resolve(options.file));
    } else {
      const captured = await captureTools(server![0]!, server!.slice(1), options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
      tools = captured.tools;
      specVersion = captured.specVersion;
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  // An empty lockfile: every tool is analyzed as new, with nothing to compare against.
  const analysis = analyzeToolList("inspect", { tools }, emptyLockfile(), specVersion, new Date())!;
  const inspected: InspectedTool[] = analysis.changes.map(({ change, reason }) => ({
    name: change.toolName,
    tier: change.tier,
    reason,
    capabilities: change.after.capabilities,
    findings: change.findings,
  }));
  const ignored = tools.filter((tool) => !hasName(tool)).length;
  const hardBlock = inspected.some((tool) => tool.tier === 3);
  return {
    version: INSPECT_REPORT_VERSION,
    source,
    specVersion,
    status: hardBlock ? "hard_block" : "ok",
    exitCode: hardBlock ? INSPECT_EXIT.hardBlock : INSPECT_EXIT.ok,
    ignored,
    tools: inspected,
  };
}

/** The tools in a file holding a tools/list result, a JSON-RPC response wrapping one, or an array. */
async function loadToolsFile(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (Array.isArray(data)) return data;
  const result = isPlainObject(data) && isPlainObject(data.result) ? data.result : data;
  if (isPlainObject(result) && Array.isArray(result.tools)) return result.tools;
  throw new Error(`${path} does not hold a tools/list result: expected { "tools": [...] }, a JSON-RPC response with one, or an array of tools`);
}

function renderText(report: InspectReport): string {
  const from = "file" in report.source ? report.source.file : report.source.command.join(" ");
  if (report.error !== undefined) {
    return `${pc.red(`✖ ${printable(report.error)}`)}\n${pc.red(`✖ error (exit ${report.exitCode})`)}\n`;
  }

  const lines = [pc.bold(`latch inspect: ${plural(report.tools.length, "tool")} from ${printable(from)}`)];
  if (report.ignored > 0) lines.push(pc.yellow(`! ignored ${plural(report.ignored, "list entry", "list entries")} without a usable name`));
  for (const tool of report.tools) {
    const critical = tool.findings.filter((finding) => finding.severity === "critical").length;
    lines.push(
      "",
      pc.bold(printable(tool.name)),
      `  capabilities  ${describeCapabilities(tool.capabilities)}`,
      `  annotations   ${describeAnnotations(tool.capabilities.declared)} ${pc.dim("(claims, not checked)")}`,
      `  findings      ${tool.findings.length === 0 ? pc.green("none") : `${critical} critical, ${tool.findings.length - critical} other`}`,
      `  first seen    ${tierLabel(tool.tier)}  ${printable(tool.reason)}`,
    );
    for (const finding of tool.findings) {
      const mark = finding.severity === "critical" ? pc.red("✖") : finding.severity === "warn" ? pc.yellow("!") : pc.dim("·");
      const evidence = finding.evidence === "" ? "" : `: ${finding.evidence}`;
      lines.push(`    ${mark} ${pc.dim(finding.type)}  ${printable(`${finding.message}${evidence}`)}`);
    }
  }

  const blocked = report.tools.filter((tool) => tool.tier === 3).length;
  lines.push(
    "",
    report.status === "hard_block"
      ? pc.red(`✖ ${plural(blocked, "tool")} would be hard-blocked at tier 3 (exit ${report.exitCode})`)
      : pc.green(`✔ no tool would be hard-blocked (exit ${report.exitCode})`),
  );
  return `${lines.join("\n")}\n`;
}

/** The tier with what the proxy would do about it, coloured by severity. */
function tierLabel(tier: Tier): string {
  if (tier === 3) return pc.red("tier 3, hard block");
  if (tier === 2) return pc.yellow("tier 2, held for review");
  return pc.green(`tier ${tier}, auto-pass once pinned`);
}

/** "filesystem read (unconstrained), network egress to any URL", or "none". */
export function describeCapabilities(caps: CapabilitySet): string {
  const parts: string[] = [];
  const { filesystem, exec, network, credentials } = caps;
  if (filesystem.read || filesystem.write) {
    const access = [filesystem.read ? "read" : "", filesystem.write ? "write" : ""].filter(Boolean).join(" and ");
    const paths = filesystem.paths.length > 0 ? `: ${filesystem.paths.join(", ")}` : "";
    parts.push(`filesystem ${access} (${filesystem.scope}${paths})`);
  }
  if (exec.enabled) parts.push(exec.shell ? "exec through a shell" : "exec");
  if (network.egress) {
    parts.push(
      network.unconstrained
        ? "network egress to any URL"
        : network.domains.length > 0
          ? `network egress to ${network.domains.join(", ")}`
          : "network egress",
    );
  }
  if (credentials.readsEnv) parts.push("reads environment variables");
  if (credentials.readsSecrets) parts.push("reads secrets");
  if (caps.crossServerRefs.length > 0) parts.push(`names other servers' tools: ${caps.crossServerRefs.join(", ")}`);
  return parts.length === 0 ? "none" : printable(parts.join(", "));
}

/** "readOnlyHint, openWorldHint, destructiveHint: false", or "none". */
export function describeAnnotations(declared: DeclaredAnnotations): string {
  const parts = Object.entries(declared)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => (value === true ? key : `${key}: ${String(value)}`));
  return parts.length === 0 ? "none" : parts.join(", ");
}

function hasName(tool: unknown): boolean {
  return isPlainObject(tool) && typeof tool.name === "string" && tool.name !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
