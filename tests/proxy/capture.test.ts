import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_PROTOCOL_VERSION, CaptureError, MAX_CAPTURE_PAGES, captureTools } from "../../src/proxy/capture.js";
import { VERSION } from "../../src/version.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A stub MCP server running `body` for each message after initialize, with `m`, `reply` and
 * `error` in scope. initialize runs `init`, which by default answers with protocol 2025-06-18.
 * `prelude` runs once at startup.
 */
const stub = (body: string, init = 'reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } })', prelude = "") => [
  "-e",
  `${prelude}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const error = (code, message) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  if (m.method === "initialize") { ${init}; return; }
  ${body}
});`,
];

const tool = (name: string) => ({ name, inputSchema: { type: "object" } });

let stderr: string[];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const capture = (args: string[], options = {}) => captureTools(process.execPath, args, options);

describe("captureTools", () => {
  it("lists the weather demo's tools and its protocol version", async () => {
    const result = await capture(["--import", "tsx", join(root, "demo/weather-server.ts")]);
    expect(result.specVersion).toBe("2025-06-18");
    expect(result.tools.map((t) => (t as { name: string }).name)).toEqual(["get_forecast", "get_alerts"]);
  });

  it("sends initialize, then notifications/initialized, then tools/list", async () => {
    const result = await capture(
      stub(
        `if (m.method === "tools/list") reply({ tools: [{ name: "seen", inputSchema: { type: "object" }, order: seen, init: params }] });
         else if (m.id === undefined) seen.push(m.method);`,
        'params = m.params; seen.push(m.method); reply({ protocolVersion: "2025-06-18" })',
        "const seen = []; let params;",
      ),
    );
    expect(result.tools).toEqual([
      {
        name: "seen",
        inputSchema: { type: "object" },
        order: ["initialize", "notifications/initialized"],
        init: { protocolVersion: CAPTURE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "latchverify", version: VERSION } },
      },
    ]);
  });

  it("follows nextCursor across pages", async () => {
    const result = await capture(
      stub(`if (m.method === "tools/list") {
        const page = m.params?.cursor ?? "p0";
        const next = { p0: "p1", p1: "p2" }[page];
        reply(next ? { tools: [${JSON.stringify(tool("a"))}, { name: page, inputSchema: { type: "object" } }], nextCursor: next } : { tools: [{ name: page, inputSchema: { type: "object" } }] });
      }`),
    );
    expect(result.tools.map((t) => (t as { name: string }).name)).toEqual(["a", "p0", "a", "p1", "p2"]);
  });

  it("answers a server's ping and refuses its other requests, without stalling", async () => {
    const result = await capture([
      "-e",
      `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const answers = {};
let listId;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } });
  if (m.method === "tools/list") {
    listId = m.id;
    send({ jsonrpc: "2.0", method: "notifications/message", params: { data: "hi" } });
    send({ jsonrpc: "2.0", id: "s1", method: "ping" });
    send({ jsonrpc: "2.0", id: "s2", method: "roots/list" });
    return;
  }
  if (m.id === "s1" || m.id === "s2") answers[m.id] = m;
  if (answers.s1 && answers.s2) send({ jsonrpc: "2.0", id: listId, result: { tools: [{ name: "x", inputSchema: { type: "object" }, answers }] } });
});`,
    ]);
    expect((result.tools[0] as { answers: unknown }).answers).toEqual({
      s1: { jsonrpc: "2.0", id: "s1", result: {} },
      s2: { jsonrpc: "2.0", id: "s2", error: { code: -32601, message: "Method not found: roots/list" } },
    });
  });

  it("passes extra environment to the server", async () => {
    const result = await capture(stub(`reply({ tools: [{ name: process.env.MCP_CAPTURE_TEST, inputSchema: { type: "object" } }] })`), {
      env: { MCP_CAPTURE_TEST: "from-env" },
    });
    expect(result.tools).toEqual([{ name: "from-env", inputSchema: { type: "object" } }]);
  });

  it("returns null for a missing protocol version", async () => {
    const result = await capture(stub("reply({ tools: [] })", "reply({})"));
    expect(result).toEqual({ tools: [], specVersion: null });
  });

  it("shuts down a server that ignores the end of its input", async () => {
    const started = Date.now();
    const result = await capture(stub("reply({ tools: [] })", undefined, "setInterval(() => {}, 1000);"));
    expect(result.tools).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("captureTools failures", () => {
  const failure = (args: string[], options = {}) =>
    capture(args, options).then(
      () => {
        throw new Error("expected a CaptureError");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(CaptureError);
        return (error as CaptureError).message;
      },
    );

  it("reports a command that cannot be started", async () => {
    await expect(captureTools("latch-no-such-binary-for-test", [])).rejects.toThrow(
      /^could not start latch-no-such-binary-for-test: spawn latch-no-such-binary-for-test ENOENT$/,
    );
  });

  it("reports a server that exits before listing its tools", async () => {
    expect(await failure(["-e", "process.exit(3)"])).toBe(`${process.execPath} exited (code 3) before listing its tools`);
  });

  it("skips stdout lines that are not JSON-RPC and reports the first one on stderr, safely quoted", async () => {
    const result = await capture(
      stub(
        `console.log("still here"); if (m.method === "tools/list") reply({ tools: [${JSON.stringify(tool("after_banner"))}] });`,
        undefined,
        'process.stdout.write("Server starting\\u001b[31m on stdio\\n");',
      ),
    );
    expect(result.tools).toEqual([tool("after_banner")]);
    const notes = stderr.join("").split("\n").filter((line) => line.startsWith("[latch]"));
    expect(notes).toEqual([
      `[latch] ${process.execPath} wrote a line that is not JSON-RPC to stdout; skipping it and any more: "Server starting\\u001b[31m on stdio"`,
    ]);
  });

  it("reports an error answer to initialize or tools/list", async () => {
    expect(await failure(stub("", 'error(-32600, "unsupported protocol")'))).toBe(
      `${process.execPath} answered initialize with error -32600: unsupported protocol`,
    );
    expect(await failure(stub('error(-32603, "boom")'))).toBe(`${process.execPath} answered tools/list with error -32603: boom`);
  });

  it("reports a tools/list result without a tools array", async () => {
    expect(await failure(stub("reply({ tools: {} })"))).toBe(`${process.execPath} answered tools/list without a tools array`);
  });

  it(`stops a server that pages past ${MAX_CAPTURE_PAGES} pages`, async () => {
    expect(await failure(stub('reply({ tools: [], nextCursor: "again" })'))).toBe(
      `${process.execPath} kept paging tools/list past ${MAX_CAPTURE_PAGES} pages`,
    );
  });

  it("times out a server that never answers, then kills it even if it ignores SIGTERM", async () => {
    const started = Date.now();
    const message = await failure(["-e", 'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    });
    expect(message).toBe(`${process.execPath} did not list its tools within 300 ms`);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);
});
