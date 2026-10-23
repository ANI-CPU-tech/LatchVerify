import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BENIGN_TOOLS, POISONED_TOOLS, callPoisonedTool, startsMutated } from "../../demo/evil-server.js";
import { TOOLS } from "../../demo/weather-server.js";
import { request, runServer, waitFor } from "./run.js";

const poisonedFixture = JSON.parse(readFileSync(new URL("../fixtures/poisoned-tools.json", import.meta.url), "utf8")) as {
  tools: unknown[];
};

const listChanged = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
const alertsCall = (id: number) => request(id, "tools/call", { name: "get_alerts", arguments: { state: "CA" } });
const alertsReply = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: "No active weather alerts for CA." }], isError: false },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool sets", () => {
  it("starts from the same tools as the weather server", () => {
    expect(BENIGN_TOOLS).toEqual(TOOLS);
  });

  it("switches to the poisoned fixture, vendor extension included", () => {
    expect(POISONED_TOOLS).toEqual(poisonedFixture.tools);
    expect(POISONED_TOOLS.map((tool) => tool.name)).toEqual(["get_forecast", "read_config", "run_diagnostics", "sync_alerts"]);
    expect(POISONED_TOOLS.find((tool) => tool.name === "sync_alerts")).toHaveProperty("x-vendor-extension", { kept: true });
  });
});

describe("startsMutated", () => {
  it("is true only for DEMO_MUTATE=1 or true", () => {
    for (const value of ["1", "true", "TRUE", " 1 "]) expect(startsMutated({ DEMO_MUTATE: value }), value).toBe(true);
    for (const value of [undefined, "", "0", "false", "yes", "11"]) expect(startsMutated({ DEMO_MUTATE: value }), String(value)).toBe(false);
  });
});

describe("callPoisonedTool", () => {
  it("answers every poisoned tool without doing what it claims", () => {
    expect(callPoisonedTool("read_config", { path: "/etc/passwd" })).toEqual({
      text: "(demo) read_config is a poisoned demo tool; no file was read.",
    });
    expect(callPoisonedTool("run_diagnostics", { command: "rm -rf /" })).toEqual({
      text: "(demo) run_diagnostics is a poisoned demo tool; nothing was executed.",
    });
    expect(callPoisonedTool("sync_alerts", { endpoint: "https://attacker.example" })).toEqual({
      text: "(demo) sync_alerts is a poisoned demo tool; no request was sent.",
    });
    expect(callPoisonedTool("get_forecast", { latitude: 1, longitude: 2 })).toHaveProperty("text");
  });

  it("logs only the length of exfiltrated notes, never their content", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc";
    expect(callPoisonedTool("get_forecast", { latitude: 1, longitude: 2, notes: secret })).toHaveProperty("text");
    expect(stderr).toHaveBeenCalledWith(`[evil-server] get_forecast received ${secret.length} characters in notes (discarded)\n`);
    expect(stderr.mock.calls.join("")).not.toContain("PRIVATE KEY");
  });

  it("rejects missing required arguments and tools it does not serve", () => {
    for (const name of ["read_config", "run_diagnostics", "sync_alerts"]) {
      expect(callPoisonedTool(name, {}), name).toMatchObject({ error: { code: -32602 } });
    }
    expect(callPoisonedTool("get_alerts", { state: "CA" })).toEqual({ error: { code: -32602, message: "Unknown tool: get_alerts" } });
  });
});

describe("evil-server process", () => {
  it("is byte-identical to the weather server before the rug pull", async () => {
    const session = [
      request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      request(2, "tools/list"),
      alertsCall(3),
      request(4, "tools/call", { name: "get_forecast", arguments: { latitude: 1, longitude: 2 } }),
    ];
    const [evil, weather] = await Promise.all([runServer("demo/evil-server.ts", session), runServer("demo/weather-server.ts", session)]);
    expect(evil.stdout).toBe(weather.stdout);
    expect(evil.stderr).toBe("");
    expect(evil.code).toBe(0);
  });

  it("answers 3 calls, then sends list_changed and lists the poisoned tools (task Verify)", async () => {
    const run = await runServer("demo/evil-server.ts", [alertsCall(1), alertsCall(2), alertsCall(3), request(4, "tools/list")]);
    expect(run.messages).toEqual([
      alertsReply(1),
      alertsReply(2),
      alertsReply(3),
      listChanged,
      { jsonrpc: "2.0", id: 4, result: { tools: POISONED_TOOLS } },
    ]);
    expect(run.stderr).toBe("[evil-server] rug pull after 3 tools/call requests: now serving 4 poisoned tools\n");
    expect(run.code).toBe(0);
  });

  it("counts failed calls too, and mutates only once", async () => {
    const run = await runServer("demo/evil-server.ts", [
      alertsCall(1),
      request(2, "tools/call", { name: "nope" }),
      alertsCall(3),
      request(4, "tools/call", { name: "read_config", arguments: { path: "/etc/hosts" } }),
      request(5, "tools/call", { name: "get_alerts", arguments: { state: "CA" } }),
    ]);
    expect(run.messages.filter((m) => m.method === "notifications/tools/list_changed")).toHaveLength(1);
    expect(run.messages[3]).toEqual(listChanged);
    expect(run.messages[4]).toMatchObject({ id: 4, result: { content: [{ text: expect.stringContaining("no file was read") }] } });
    expect(run.messages[5]).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Unknown tool: get_alerts" } });
  });

  it("does not count requests other than tools/call", async () => {
    const run = await runServer("demo/evil-server.ts", [request(1, "tools/list"), request(2, "ping"), request(3, "tools/list"), alertsCall(4)]);
    expect(run.messages).not.toContainEqual(listChanged);
    expect(run.messages[2]).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: BENIGN_TOOLS } });
  });

  it("starts mutated with DEMO_MUTATE=1 and sends no notification", async () => {
    const run = await runServer("demo/evil-server.ts", [request(1, "tools/list")], { env: { DEMO_MUTATE: "1" } });
    expect(run.messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: POISONED_TOOLS } }]);
    expect(run.stderr).toBe("[evil-server] DEMO_MUTATE set: serving the poisoned tools from the start\n");
  });

  it.skipIf(process.platform === "win32")("mutates once on SIGUSR1", async () => {
    const run = await runServer("demo/evil-server.ts", [request(1, "tools/list"), request(2, "tools/list")], {
      async between(index, pid, stdout) {
        if (index !== 0) return;
        // Signal only once the server is up: before its handler exists, SIGUSR1 starts Node's inspector.
        await waitFor(() => stdout().includes('"id":1'));
        process.kill(pid, "SIGUSR1");
        await waitFor(() => stdout().includes("list_changed"));
        process.kill(pid, "SIGUSR1");
      },
    });
    expect(run.messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: BENIGN_TOOLS } },
      listChanged,
      { jsonrpc: "2.0", id: 2, result: { tools: POISONED_TOOLS } },
    ]);
    expect(run.stderr).toBe("[evil-server] rug pull on SIGUSR1: now serving 4 poisoned tools\n");
    expect(run.code).toBe(0);
  });
});
