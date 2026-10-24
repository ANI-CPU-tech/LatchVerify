/**
 * Installer smoke-test assertion: is a Claude Code server linked to latch, or restored?
 *
 *   tsx packaging/test/check-link.ts linked   --config <~/.claude.json> --lockfile <latch.lock> --server <id>
 *   tsx packaging/test/check-link.ts unlinked --config <~/.claude.json> --lockfile <latch.lock> --server <id>
 *
 * linked: the entry starts `latch proxy --server <id>` with LATCH_LOCKFILE_PATH set to the
 * lockfile, and the lockfile pins at least one of the server's tools.
 * unlinked: the entry runs its own command again with no LATCH_* variables, and the lockfile is
 * still there (uninstalling keeps the approvals).
 *
 * Exits 0 when the check holds, 1 with the reason when it does not.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface Entry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function checkLinked(config: unknown, lock: unknown, serverId: string, lockfilePath: string): string | null {
  const entry = serverEntry(config, serverId);
  if (!entry) return `no "${serverId}" entry in the Claude Code config`;
  const args = entry.args ?? [];
  const at = args.indexOf("proxy");
  if (at === -1 || args[at + 1] !== "--server" || args[at + 2] !== serverId) return `"${serverId}" does not start latch proxy: ${[entry.command, ...args].join(" ")}`;
  if (entry.env?.LATCH_LOCKFILE_PATH !== lockfilePath) return `"${serverId}" has LATCH_LOCKFILE_PATH=${entry.env?.LATCH_LOCKFILE_PATH}, expected ${lockfilePath}`;
  const tools = (lock as { servers?: Record<string, { tools?: unknown[] }> }).servers?.[serverId]?.tools ?? [];
  if (tools.length === 0) return `latch.lock pins no tool of "${serverId}"`;
  return null;
}

export function checkUnlinked(config: unknown, serverId: string): string | null {
  const entry = serverEntry(config, serverId);
  if (!entry) return `no "${serverId}" entry in the Claude Code config`;
  if ((entry.args ?? []).includes("proxy")) return `"${serverId}" still starts latch proxy`;
  const leftover = Object.keys(entry.env ?? {}).filter((key) => key.startsWith("LATCH_"));
  if (leftover.length > 0) return `"${serverId}" still has ${leftover.join(", ")}`;
  return null;
}

function serverEntry(config: unknown, serverId: string): Entry | undefined {
  return (config as { mcpServers?: Record<string, Entry> }).mcpServers?.[serverId];
}

if (process.argv[1]?.endsWith("check-link.ts")) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, lockfile: { type: "string" }, server: { type: "string" } },
  });
  const [mode] = positionals;
  const { config, lockfile, server } = values;
  if ((mode !== "linked" && mode !== "unlinked") || !config || !lockfile || !server) {
    console.error("usage: check-link.ts linked|unlinked --config <path> --lockfile <path> --server <id>");
    process.exit(2);
  }
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  let problem: string | null;
  if (!existsSync(lockfile)) problem = `${lockfile} does not exist`;
  else problem = mode === "linked" ? checkLinked(read(config), read(lockfile), server, lockfile) : checkUnlinked(read(config), server);
  if (problem) {
    console.error(`✖ ${mode}: ${problem}`);
    process.exit(1);
  }
  console.log(`✔ ${server} is ${mode} (${config}, ${lockfile})`);
}
