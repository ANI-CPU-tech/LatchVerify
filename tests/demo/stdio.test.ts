import { realpathSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  RPC_ERROR,
  invalidArguments,
  isEntryPoint,
  reply,
  serveStdio,
  unknownTool,
  type CallOutcome,
  type DemoServer,
} from "../../demo/weather-server.js";
import { parseLine, type JsonRpcResponse } from "../../src/proxy/transport.js";
import type { McpTool } from "../../src/schema/index.js";

const tool: McpTool = { name: "echo", inputSchema: { type: "object" } };

/** A minimal server: one `echo` tool, and `boom` throws. */
function stubServer(overrides: Partial<DemoServer> = {}): DemoServer {
  return {
    info: { name: "stub", version: "1.0.0" },
    logName: "stub",
    tools: () => [tool],
    call: (name, args): CallOutcome => {
      if (name === "boom") throw new Error("kaboom");
      return name === "echo" ? { text: JSON.stringify(args) } : unknownTool(name);
    },
    ...overrides,
  };
}

const ask = (line: string, server = stubServer()): JsonRpcResponse | null => reply(server, parseLine(line));

const call = (params: unknown, server = stubServer()) =>
  ask(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params }), server);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reply", () => {
  it("answers initialize with the protocol version, tools capability and server info", () => {
    expect(ask('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "stub", version: "1.0.0" },
      },
    });
    expect(PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("answers ping with an empty result", () => {
    expect(ask('{"jsonrpc":"2.0","id":"p","method":"ping"}')).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists the tools the server returns at the time of the request", () => {
    let tools: McpTool[] = [tool];
    const server = stubServer({ tools: () => tools });
    expect(ask('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', server)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [tool] } });
    tools = [];
    expect(ask('{"jsonrpc":"2.0","id":3,"method":"tools/list"}', server)).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
  });

  it("answers an unknown method with -32601, echoing the id", () => {
    for (const id of [1, "a", null]) {
      expect(ask(JSON.stringify({ jsonrpc: "2.0", id, method: "resources/list" }))).toEqual({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found: resources/list" },
      });
    }
  });

  it("never answers notifications, responses or blank lines", () => {
    for (const line of [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","method":"notifications/unknown","params":{}}',
      '{"jsonrpc":"2.0","method":"tools/list"}',
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"}}',
      "",
      "  ",
    ]) {
      expect(ask(line), line).toBeNull();
    }
  });

  it("answers a line that is not JSON with a parse error and a null id", () => {
    expect(ask("not json")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: line is not valid JSON" } });
  });

  it("answers JSON that is not one JSON-RPC message with an invalid-request error", () => {
    for (const line of ['{"id":1,"method":"tools/list"}', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', "42", "null"]) {
      expect(ask(line), line).toMatchObject({ id: null, error: { code: RPC_ERROR.invalidRequest } });
    }
  });

  it("answers a message with a malformed method or id with an invalid-request error", () => {
    expect(ask('{"jsonrpc":"2.0","id":4,"method":5}')).toMatchObject({ id: 4, error: { code: -32600 } });
    expect(ask('{"jsonrpc":"2.0","id":{},"method":"ping"}')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(ask('{"jsonrpc":"2.0","method":null}')).toMatchObject({ id: null, error: { code: -32600 } });
  });
});

describe("tools/call", () => {
  it("returns the tool's text as a single text content block", () => {
    expect(call({ name: "echo", arguments: { a: 1 } })).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { content: [{ type: "text", text: '{"a":1}' }], isError: false },
    });
  });

  it("passes empty arguments when they are omitted", () => {
    expect(call({ name: "echo" })).toMatchObject({ result: { content: [{ text: "{}" }] } });
  });

  it("rejects params without a string name", () => {
    for (const params of [undefined, null, [], "echo", {}, { name: 5 }]) {
      expect(call(params), JSON.stringify(params)).toMatchObject({ id: 9, error: { code: -32602 } });
    }
  });

  it("rejects arguments that are not an object", () => {
    for (const args of [null, [], "x", 1]) {
      expect(call({ name: "echo", arguments: args }), JSON.stringify(args)).toMatchObject({
        error: { code: -32602, message: "Invalid params: arguments must be an object" },
      });
    }
  });

  it("returns the tool's JSON-RPC error unchanged", () => {
    expect(call({ name: "nope" })).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32602, message: "Unknown tool: nope" } });
    expect(invalidArguments("echo", "x is required")).toEqual({
      error: { code: -32602, message: "Invalid arguments for echo: x is required" },
    });
  });

  it("turns a throwing tool into -32603 and logs the cause to stderr only", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(call({ name: "boom" })).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32603, message: "Internal error" } });
    expect(stderr).toHaveBeenCalledWith("[stub] tool boom failed: kaboom\n");
  });
});

/** Collected output lines of a session, parsed. */
const lines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);

function session(hooks?: Parameters<typeof serveStdio>[1]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  const running = serveStdio(stubServer(), hooks, input, output);
  return { input, output, running, text: () => text };
}

describe("serveStdio", () => {
  it("answers requests in order and resolves once input ends and output is flushed", async () => {
    const { input, running, text } = session();
    input.end(
      [
        '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
        '{"jsonrpc":"2.0","id":3,"method":"ping"}',
      ].join("\n"),
    );
    await running.closed;
    expect(lines(text()).map((m) => (m as { id: unknown }).id)).toEqual([1, 2, 3]);
    expect(text().endsWith("\n")).toBe(true);
  });

  it("writes a message sent from afterReply right after that reply", async () => {
    const { input, running, text } = session({
      afterReply(request, s) {
        if (request.method === "tools/call") s.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      },
    });
    input.end(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    );
    await running.closed;
    expect(lines(text())).toEqual([
      expect.objectContaining({ id: 1 }),
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      expect.objectContaining({ id: 2 }),
    ]);
  });

  it("does not call afterReply for notifications or invalid lines", async () => {
    const afterReply = vi.fn();
    const { input, running } = session({ afterReply });
    input.end('{"jsonrpc":"2.0","method":"tools/call"}\nnot json\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await running.closed;
    expect(afterReply).not.toHaveBeenCalled();
  });

  it("rejects closed and stops reading when output fails", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const afterReply = vi.fn();
    const running = serveStdio(stubServer(), { afterReply }, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await expect(running.closed).rejects.toThrow("write EPIPE");
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    expect(afterReply).toHaveBeenCalledTimes(1);
  });
});

describe("isEntryPoint", () => {
  it("is true only for the script the process was started with", () => {
    expect(isEntryPoint(pathToFileURL(realpathSync(process.argv[1]!)).href)).toBe(true);
    expect(isEntryPoint(new URL("../../demo/weather-server.ts", import.meta.url).href)).toBe(false);
    expect(isEntryPoint("file:///no/such/file.ts")).toBe(false);
  });
});
