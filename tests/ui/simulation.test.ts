import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCK_ERROR_CODE } from "../../src/proxy/blocker.js";
import { SimulationResultSchema, type SimulationRequest } from "../../src/schema/index.js";
import { SIMULATION_REVIEWER, SimulationInputError, simulateRugPull } from "../../src/ui/simulation.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const NOW = new Date("2026-10-24T10:00:00.000Z");
const request: SimulationRequest = {
  serverId: "weather",
  pinned: fixture("benign-tools.json"),
  served: fixture("poisoned-tools.json"),
  callsBefore: ["get_alerts", "get_alerts", "get_alerts"],
  callsAfter: ["get_forecast", "read_config"],
};

describe("simulateRugPull", () => {
  const result = simulateRugPull(request, NOW);

  it("returns a valid result", () => {
    expect(SimulationResultSchema.parse(result)).toEqual(result);
  });

  it("pins every benign tool as the simulation", () => {
    expect(result.pinned.map((tool) => tool.name)).toEqual(["get_alerts", "get_forecast"]);
    for (const tool of result.pinned) expect(tool).toMatchObject({ serverId: "weather", approvedBy: SIMULATION_REVIEWER, approvedAt: NOW.toISOString() });
  });

  it("forwards the calls made before the rug pull", () => {
    expect(result.callsBefore).toEqual(request.callsBefore.map((toolName) => ({ toolName, blocked: null })));
  });

  it("finds the poisoned get_forecast at tier 3 and queues the new tools", () => {
    const forecast = result.changes.find((change) => change.toolName === "get_forecast")!;
    expect(forecast.tier).toBe(3);
    expect(forecast.findings.some((finding) => finding.severity === "critical")).toBe(true);
    expect(result.changes.map((change) => change.toolName)).toEqual(expect.arrayContaining(["read_config", "run_diagnostics", "sync_alerts"]));
  });

  it("hard-blocks get_forecast afterwards with the proxy's own JSON-RPC error", () => {
    const [forecast, config] = result.callsAfter;
    const changeId = result.changes.find((change) => change.toolName === "get_forecast")!.id;
    expect(forecast).toEqual({
      toolName: "get_forecast",
      blocked: {
        jsonrpc: "2.0",
        id: 4,
        error: { code: BLOCK_ERROR_CODE, message: 'LatchVerify blocked "get_forecast" pending review — run `latch review`', data: { reason: { kind: "hard_block", changeId } } },
      },
    });
    expect(config!.blocked?.error.code).toBe(BLOCK_ERROR_CODE);
  });

  it("finds nothing to queue when the server does not change", () => {
    const calm = simulateRugPull({ ...request, served: request.pinned }, NOW);
    expect(calm.changes).toEqual([]);
    expect(calm.unchanged.sort()).toEqual(["get_alerts", "get_forecast"]);
    expect(calm.callsAfter.every((call) => call.toolName !== "get_forecast" || call.blocked === null)).toBe(true);
  });

  it("rejects lists that are not tools/list results", () => {
    expect(() => simulateRugPull({ ...request, pinned: { nope: true } }, NOW)).toThrow(SimulationInputError);
    expect(() => simulateRugPull({ ...request, served: [] }, NOW)).toThrow(SimulationInputError);
  });
});
