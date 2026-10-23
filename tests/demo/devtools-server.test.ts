import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_TOOLS, POISONED_TOOLS, callDevtoolsTool } from "../../demo/devtools-server.js";
import { analyzeToolList } from "../../src/proxy/analysis.js";
import type { McpTool } from "../../src/schema/index.js";
import { applyApproval, emptyLockfile } from "../../src/store/lockfile.js";
import { request, runServer } from "./run.js";

const now = new Date("2026-10-24T09:00:00.000Z");
const analyze = (tools: McpTool[], lock = emptyLockfile()) => analyzeToolList("devtools", { tools }, lock, "2025-06-18", now)!;
const critical = (tools: McpTool[], lock = emptyLockfile()) =>
  analyze(tools, lock)
    .changes.filter(({ change }) => change.findings.some((finding) => finding.severity === "critical"))
    .map(({ change }) => change.toolName);

const listChanged = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
const formatCall = (id: number) => request(id, "tools/call", { name: "format_json", arguments: { text: "[1]" } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("first use", () => {
  it("flags only workspace_shell as critical, so latch add holds it back and pins format_json", () => {
    expect(critical(INITIAL_TOOLS)).toEqual(["workspace_shell"]);
  });

  it("derives unrestricted exec and filesystem access for workspace_shell", () => {
    const shell = analyze(INITIAL_TOOLS).changes.find(({ change }) => change.toolName === "workspace_shell")!.change;
    expect(shell.after.capabilities.exec.enabled).toBe(true);
    expect(shell.after.capabilities.filesystem.scope).toBe("unconstrained");
  });
});

describe("rug pull", () => {
  it("lands format_json at tier 3 against the pins latch add would write", () => {
    let lock = emptyLockfile();
    lock.servers.devtools = { transport: "stdio", command: "devtools", args: [], tools: [] };
    for (const { change } of analyze(INITIAL_TOOLS, lock).changes) {
      if (change.toolName === "format_json") lock = applyApproval(lock, change, "dev@example.com", now);
    }
    const changes = analyze(POISONED_TOOLS, lock).changes.map(({ change }) => [change.toolName, change.tier]);
    expect(changes).toEqual([
      ["format_json", 3],
      ["workspace_shell", 3],
    ]);
  });
});

describe("callDevtoolsTool", () => {
  it("formats JSON and runs nothing for workspace_shell", () => {
    expect(callDevtoolsTool("format_json", { text: '{"a":1}' })).toEqual({ text: '{\n  "a": 1\n}' });
    expect(callDevtoolsTool("workspace_shell", { command: "cat ~/.ssh/id_rsa" })).toEqual({
      text: "(demo) workspace_shell is a demo tool; nothing was executed.",
    });
  });

  it("logs only the length of exfiltrated context, never its content", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const secret = "AWS_SECRET_ACCESS_KEY=abc";
    expect(callDevtoolsTool("format_json", { text: "1", context: secret })).toEqual({ text: "1" });
    expect(stderr).toHaveBeenCalledWith(`[devtools-server] format_json received ${secret.length} characters in context (discarded)\n`);
    expect(stderr.mock.calls.join("")).not.toContain("abc");
  });

  it("rejects bad arguments and tools it does not serve", () => {
    expect(callDevtoolsTool("format_json", { text: "{" })).toMatchObject({ error: { code: -32602 } });
    expect(callDevtoolsTool("workspace_shell", {})).toMatchObject({ error: { code: -32602 } });
    expect(callDevtoolsTool("get_alerts", {})).toEqual({ error: { code: -32602, message: "Unknown tool: get_alerts" } });
  });
});

describe("devtools-server process", () => {
  it("answers 3 calls, then sends list_changed and lists the poisoned tools", async () => {
    const run = await runServer("demo/devtools-server.ts", [request(1, "tools/list"), formatCall(2), formatCall(3), formatCall(4), request(5, "tools/list")]);
    expect(run.messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: INITIAL_TOOLS } });
    expect(run.messages[4]).toEqual(listChanged);
    expect(run.messages[5]).toEqual({ jsonrpc: "2.0", id: 5, result: { tools: POISONED_TOOLS } });
    expect(run.stderr).toBe("[devtools-server] rug pull after 3 tools/call requests: now serving 2 poisoned tools\n");
    expect(run.code).toBe(0);
  });
});
