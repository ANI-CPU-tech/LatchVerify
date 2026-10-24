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
 *   tsx packaging/test/check-link.ts probe    --config <~/.claude.json> --server <id> --tool <name>
 *
 * probe: starts the entry exactly as Claude Code would (its command, args and env) and speaks
 * MCP to it: initialize, tools/list (the tool must be listed) and tools/call (it must answer, not
 * with the proxy's -32001 block). Proves the installed latch and its Node.js actually run.
 *
 * Exits 0 when the check holds, 1 with the reason when it does not.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
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

/** Start `entry` and check it lists and answers `tool`. Resolves null when it does, else the reason. */
export function probe(entry: Entry, tool: string, timeoutMs = 60_000): Promise<string | null> {
  return new Promise((resolveProbe) => {
    const child = spawn(entry.command, entry.args ?? [], { env: { ...process.env, ...entry.env }, stdio: ["pipe", "pipe", "inherit"] });
    let settled = false;
    const finish = (problem: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolveProbe(problem);
    };
    const timer = setTimeout(() => finish(`no answer within ${timeoutMs} ms`), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (error) => finish(`could not start ${entry.command}: ${error.message}`));
    child.on("exit", (code) => finish(`exited (code ${code}) before answering`));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: number; result?: { tools?: Array<{ name: string }> }; error?: { code: number; message: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return finish(`wrote something other than JSON-RPC to stdout: ${line.slice(0, 120)}`);
      }
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (message.id === 2) {
        if (!message.result?.tools?.some((listed) => listed.name === tool)) return finish(`tools/list does not list "${tool}": ${line.slice(0, 200)}`);
        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: { text: "latch smoke test" } } });
      } else if (message.id === 3) {
        finish(message.error ? `tools/call was refused: ${message.error.code} ${message.error.message}` : null);
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "latch-smoke-test", version: "1" } } });
  });
}

function serverEntry(config: unknown, serverId: string): Entry | undefined {
  return (config as { mcpServers?: Record<string, Entry> }).mcpServers?.[serverId];
}

if (process.argv[1]?.endsWith("check-link.ts")) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, lockfile: { type: "string" }, server: { type: "string" }, tool: { type: "string" } },
  });
  const [mode] = positionals;
  const { config, lockfile, server, tool } = values;
  const usable = mode === "probe" ? config && server && tool : (mode === "linked" || mode === "unlinked") && config && lockfile && server;
  if (!usable) {
    console.error("usage: check-link.ts linked|unlinked --config <path> --lockfile <path> --server <id>\n       check-link.ts probe --config <path> --server <id> --tool <name>");
    process.exit(2);
  }
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  let problem: string | null;
  if (mode === "probe") {
    const entry = serverEntry(read(config!), server!);
    problem = entry ? await probe(entry, tool!) : `no "${server}" entry in the Claude Code config`;
  } else if (!existsSync(lockfile!)) problem = `${lockfile} does not exist`;
  else problem = mode === "linked" ? checkLinked(read(config!), read(lockfile!), server!, lockfile!) : checkUnlinked(read(config!), server!);
  if (problem) {
    console.error(`✖ ${mode}: ${problem}`);
    process.exit(1);
  }
  console.log(mode === "probe" ? `✔ ${server} starts and answers ${tool} through ${config}` : `✔ ${server} is ${mode} (${config}, ${lockfile})`);
}
