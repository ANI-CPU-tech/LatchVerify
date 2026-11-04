/**
 * Installer smoke-test assertion: is a Claude Code server linked to latch, or restored?
 *
 *   tsx packaging/test/check-link.ts client   --config <~/.claude.json> --server <id>
 *
 * client: writes a Claude Code config whose only server, <id>, runs stub-server.mjs with this
 * Node.js, by absolute paths, as an installer finds it on a fresh machine.
 *
 *   tsx packaging/test/check-link.ts linked   --config <~/.claude.json> --lockfile <latch.lock> --server <id>
 *   tsx packaging/test/check-link.ts pinned   --config <~/.claude.json> --lockfile <latch.lock> --server <id>
 *   tsx packaging/test/check-link.ts unlinked --config <~/.claude.json> --lockfile <latch.lock> --server <id>
 *
 * linked: the entry starts `latch --lockfile <latch.lock> ... proxy --server <id>`, carries no
 * LATCH_* variable in its env, and the lockfile lists the server.
 * pinned: after the server's first run (probe), the lockfile pins at least one of its tools and
 * no longer marks it for trust on first use.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Entry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A Claude Code config with one stdio server, `serverId`, running stub-server.mjs with this Node.js. */
export function stubClientConfig(serverId: string): { mcpServers: Record<string, Entry> } {
  return { mcpServers: { [serverId]: { command: process.execPath, args: [fileURLToPath(new URL("stub-server.mjs", import.meta.url))] } } };
}

export function checkLinked(config: unknown, lock: unknown, serverId: string, lockfilePath: string): string | null {
  const entry = serverEntry(config, serverId);
  if (!entry) return `no "${serverId}" entry in the Claude Code config`;
  const args = entry.args ?? [];
  const at = args.indexOf("proxy");
  if (at === -1 || args[at + 1] !== "--server" || args[at + 2] !== serverId) return `"${serverId}" does not start latch proxy: ${[entry.command, ...args].join(" ")}`;
  const lockAt = args.indexOf("--lockfile");
  if (lockAt === -1 || lockAt > at || args[lockAt + 1] !== lockfilePath) return `"${serverId}" does not pass --lockfile ${lockfilePath} to latch`;
  const leftover = Object.keys(entry.env ?? {}).filter((key) => key.startsWith("LATCH_"));
  if (leftover.length > 0) return `"${serverId}" has ${leftover.join(", ")} in its env`;
  if ((lock as { servers?: Record<string, unknown> }).servers?.[serverId] === undefined) return `latch.lock does not list "${serverId}"`;
  return null;
}

export function checkPinned(lock: unknown, serverId: string): string | null {
  const server = (lock as { servers?: Record<string, { tools?: unknown[]; trustOnFirstUse?: boolean }> }).servers?.[serverId];
  if (server === undefined) return `latch.lock does not list "${serverId}"`;
  if ((server.tools ?? []).length === 0) return `latch.lock pins no tool of "${serverId}"`;
  if (server.trustOnFirstUse === true) return `"${serverId}" is still marked for trust on first use`;
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
  const usable =
    mode === "client" ? config && server : mode === "probe" ? config && server && tool : (mode === "linked" || mode === "pinned" || mode === "unlinked") && config && lockfile && server;
  if (!usable) {
    console.error("usage: check-link.ts client --config <path> --server <id>\n       check-link.ts linked|pinned|unlinked --config <path> --lockfile <path> --server <id>\n       check-link.ts probe --config <path> --server <id> --tool <name>");
    process.exit(2);
  }
  if (mode === "client") {
    writeFileSync(config!, `${JSON.stringify(stubClientConfig(server!), null, 2)}\n`);
    console.log(`✔ wrote ${config} with the stub server "${server}"`);
    process.exit(0);
  }
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  let problem: string | null;
  if (mode === "probe") {
    const entry = serverEntry(read(config!), server!);
    problem = entry ? await probe(entry, tool!) : `no "${server}" entry in the Claude Code config`;
  } else if (!existsSync(lockfile!)) problem = `${lockfile} does not exist`;
  else if (mode === "linked") problem = checkLinked(read(config!), read(lockfile!), server!, lockfile!);
  else if (mode === "pinned") problem = checkPinned(read(lockfile!), server!);
  else problem = checkUnlinked(read(config!), server!);
  if (problem) {
    console.error(`✖ ${mode}: ${problem}`);
    process.exit(1);
  }
  console.log(mode === "probe" ? `✔ ${server} starts and answers ${tool} through ${config}` : `✔ ${server} is ${mode} (${config}, ${lockfile})`);
}
