import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS, WEATHER_SERVER_INFO, callWeatherTool } from "../../demo/weather-server.js";
import { McpToolListSchema } from "../../src/schema/index.js";
import { request, runServer } from "./run.js";

const benignFixture = JSON.parse(readFileSync(new URL("../fixtures/benign-tools.json", import.meta.url), "utf8")) as {
  tools: unknown[];
};

describe("TOOLS", () => {
  it("is the benign fixture, unchanged", () => {
    expect(TOOLS).toEqual(benignFixture.tools);
    expect(TOOLS.map((tool) => tool.name)).toEqual(["get_forecast", "get_alerts"]);
  });
});

describe("callWeatherTool", () => {
  it("answers get_forecast in metric by default and in imperial on request", () => {
    expect(callWeatherTool("get_forecast", { latitude: 37.7749, longitude: -122.4194 })).toEqual({
      text: "Forecast for 37.77, -122.42: partly cloudy, high 18°C, low 11°C, wind 14 km/h.",
    });
    expect(callWeatherTool("get_forecast", { latitude: 0, longitude: 0, units: "imperial" })).toEqual({
      text: "Forecast for 0.00, 0.00: partly cloudy, high 64°F, low 52°F, wind 9 mph.",
    });
  });

  it("accepts the coordinate limits and ignores extra arguments", () => {
    expect(callWeatherTool("get_forecast", { latitude: -90, longitude: 180, extra: "x" })).toHaveProperty("text");
    expect(callWeatherTool("get_forecast", { latitude: 90, longitude: -180 })).toHaveProperty("text");
  });

  it("rejects coordinates that are missing, out of range or not finite numbers", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ longitude: 0 }, "latitude"],
      [{ latitude: 90.01, longitude: 0 }, "latitude"],
      [{ latitude: "37", longitude: 0 }, "latitude"],
      [{ latitude: Number.NaN, longitude: 0 }, "latitude"],
      [{ latitude: 0 }, "longitude"],
      [{ latitude: 0, longitude: -180.5 }, "longitude"],
      [{ latitude: 0, longitude: Number.POSITIVE_INFINITY }, "longitude"],
    ];
    for (const [args, field] of cases) {
      expect(callWeatherTool("get_forecast", args), JSON.stringify(args)).toEqual({
        error: { code: -32602, message: expect.stringContaining(`Invalid arguments for get_forecast: ${field}`) },
      });
    }
  });

  it("rejects units outside the enum", () => {
    for (const units of ["kelvin", "METRIC", null, 1]) {
      expect(callWeatherTool("get_forecast", { latitude: 0, longitude: 0, units })).toMatchObject({
        error: { code: -32602, message: 'Invalid arguments for get_forecast: units must be "metric" or "imperial"' },
      });
    }
  });

  it("answers get_alerts for a two-letter state code, normalized to upper case", () => {
    expect(callWeatherTool("get_alerts", { state: "CA" })).toEqual({ text: "No active weather alerts for CA." });
    expect(callWeatherTool("get_alerts", { state: "ny" })).toEqual({ text: "No active weather alerts for NY." });
  });

  it("rejects a state that is not two letters", () => {
    for (const state of [undefined, "", "C", "CAL", "C1", " CA", 12]) {
      expect(callWeatherTool("get_alerts", { state }), String(state)).toMatchObject({ error: { code: -32602 } });
    }
  });

  it("answers an unknown tool with -32602", () => {
    expect(callWeatherTool("read_config", { path: "/etc/passwd" })).toEqual({
      error: { code: -32602, message: "Unknown tool: read_config" },
    });
  });
});

describe("weather-server process", () => {
  it("lists the two benign tools for a bare tools/list (task Verify)", async () => {
    const run = await runServer("demo/weather-server.ts", [request(1, "tools/list")]);
    expect(run).toEqual({ messages: [{ jsonrpc: "2.0", id: 1, result: { tools: TOOLS } }], stderr: "", code: 0 });
    expect(McpToolListSchema.parse((run.messages[0] as { result: unknown }).result).tools).toHaveLength(2);
  });

  it("serves a full MCP session and exits 0 when stdin closes", async () => {
    const run = await runServer("demo/weather-server.ts", [
      request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      request(2, "tools/list"),
      request(3, "tools/call", { name: "get_forecast", arguments: { latitude: 1, longitude: 2 } }),
      request(4, "tools/call", { name: "get_alerts", arguments: { state: "CA" } }),
      request(5, "tools/call", { name: "nope", arguments: {} }),
      request(6, "resources/list"),
      "not json",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: WEATHER_SERVER_INFO },
      },
      { jsonrpc: "2.0", id: 2, result: { tools: TOOLS } },
      expect.objectContaining({ id: 3, result: expect.objectContaining({ isError: false }) }),
      { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "No active weather alerts for CA." }], isError: false } },
      { jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Unknown tool: nope" } },
      { jsonrpc: "2.0", id: 6, error: { code: -32601, message: "Method not found: resources/list" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: line is not valid JSON" } },
    ]);
  });
});
