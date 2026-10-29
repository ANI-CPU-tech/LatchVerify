import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNotification,
  isRequest,
  isResponse,
  parseLine,
  readFrames,
  serialize,
  serverEnvironment,
  spawnUpstream,
  writeLine,
  type Frame,
  type JsonRpcMessage,
} from "../../src/proxy/transport.js";

/** Parse a line that must be a JSON-RPC message. */
const message = (line: string): JsonRpcMessage => {
  const { message } = parseLine(line);
  if (message === null) throw new Error(`not a JSON-RPC message: ${line}`);
  return message;
};

const classify = (line: string) => {
  const m = message(line);
  return { request: isRequest(m), notification: isNotification(m), response: isResponse(m) };
};

describe("parseLine", () => {
  it("parses a JSON-RPC message and keeps the line as raw", () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    expect(parseLine(line)).toEqual({ raw: line, message: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  });

  it("keeps unknown fields in both raw and message", () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"x","x-extra":{"kept":true},"_meta":{"a":[1,2]}}';
    const frame = parseLine(line);
    expect(frame.raw).toBe(line);
    expect(frame.message).toMatchObject({ "x-extra": { kept: true }, _meta: { a: [1, 2] } });
  });

  it("keeps raw byte-for-byte, including whitespace and escapes the parser normalizes", () => {
    const line = '  { "jsonrpc" : "2.0", "id": 1.0, "method": "caf\\u00e9", "p": "\\/" }\t';
    const frame = parseLine(line);
    expect(frame.raw).toBe(line);
    expect(frame.message).toEqual({ jsonrpc: "2.0", id: 1, method: "café", p: "/" });
  });

  it("returns a null message for lines that are not JSON-RPC 2.0 objects", () => {
    const lines = [
      "",
      "   ",
      "not json",
      '{"jsonrpc":"2.0"',
      "null",
      "42",
      '"2.0"',
      "true",
      '{"id":1,"method":"x"}',
      '{"jsonrpc":"1.0","id":1,"method":"x"}',
      '{"jsonrpc":2,"id":1,"method":"x"}',
      '[{"jsonrpc":"2.0","id":1,"method":"x"}]',
      "[]",
    ];
    for (const line of lines) expect(parseLine(line)).toEqual({ raw: line, message: null });
  });

  it("tolerates a trailing carriage return from a CRLF peer", () => {
    const line = '{"jsonrpc":"2.0","method":"x"}\r';
    expect(parseLine(line)).toEqual({ raw: line, message: { jsonrpc: "2.0", method: "x" } });
  });

  it("stores an own __proto__ key as data without touching the prototype", () => {
    const frame = parseLine('{"jsonrpc":"2.0","method":"x","__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(frame.message)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(frame.message!, "__proto__")).toBe(true);
  });
});

describe("message type guards", () => {
  it("classifies requests, including string and null ids", () => {
    for (const id of ["1", '"abc"', '""', "0", "-1.5", "null"]) {
      expect(classify(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{}}`)).toEqual({
        request: true,
        notification: false,
        response: false,
      });
    }
  });

  it("classifies notifications by the absence of id", () => {
    expect(classify('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}')).toEqual({
      request: false,
      notification: true,
      response: false,
    });
  });

  it("classifies results and errors as responses", () => {
    const expected = { request: false, notification: false, response: true };
    expect(classify('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')).toEqual(expected);
    expect(classify('{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"nope"}}')).toEqual(expected);
    expect(classify('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}')).toEqual(expected);
  });

  it("matches no guard when method or id has the wrong type", () => {
    const none = { request: false, notification: false, response: false };
    for (const line of [
      '{"jsonrpc":"2.0","id":1,"method":5}',
      '{"jsonrpc":"2.0","method":null}',
      '{"jsonrpc":"2.0","id":{},"method":"x"}',
      '{"jsonrpc":"2.0","id":[1],"result":1}',
      '{"jsonrpc":"2.0","id":true,"result":1}',
      '{"jsonrpc":"2.0","method":5,"result":1}',
      '{"jsonrpc":"2.0","result":1}',
      '{"jsonrpc":"2.0"}',
    ]) {
      expect(classify(line), line).toEqual(none);
    }
  });

  it("never classifies one message as two kinds", () => {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"x"}',
      '{"jsonrpc":"2.0","method":"x"}',
      '{"jsonrpc":"2.0","id":1,"result":1}',
      '{"jsonrpc":"2.0","id":1,"method":"x","result":1}',
      '{"jsonrpc":"2.0","method":"x","result":1}',
    ];
    for (const line of lines) {
      const kinds = Object.values(classify(line)).filter(Boolean);
      expect(kinds.length, line).toBeLessThanOrEqual(1);
    }
  });
});

/** Everything written to `stream` so far, as text. */
const collect = (stream: PassThrough): (() => string) => {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
};

/** A Writable that holds every chunk until the test releases it. */
function stalledWritable() {
  const written: string[] = [];
  const held: Array<() => void> = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      held.push(() => {
        written.push(chunk.toString("utf8"));
        callback();
      });
    },
  });
  const releaseOne = () => held.shift()?.();
  return { stream, written, releaseOne, heldCount: () => held.length };
}

/** Resolves on the next macrotask, after every pending stream callback has run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("serialize", () => {
  it("writes one compact line that parses back to the message", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 7, error: { code: -32001, message: "blocked" }, "x-extra": [1] };
    const line = serialize(msg);
    expect(line).toBe('{"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"blocked"},"x-extra":[1]}\n');
    expect(parseLine(line.slice(0, -1)).message).toEqual(msg);
  });

  it("never emits a line break inside the line", () => {
    const line = serialize({ jsonrpc: "2.0", method: "a\nb\rc\u2028d", params: { text: "x\r\ny" } });
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(line.endsWith("\n")).toBe(true);
  });

  it("throws on values JSON cannot represent", () => {
    expect(() => serialize({ jsonrpc: "2.0", method: "x", params: 1n })).toThrow(TypeError);
  });
});

describe("writeLine", () => {
  it("terminates a raw line with exactly one newline", async () => {
    const out = new PassThrough();
    const text = collect(out);
    await writeLine(out, '{"jsonrpc":"2.0","method":"x"}');
    await writeLine(out, "");
    await writeLine(out, "not json");
    expect(text()).toBe('{"jsonrpc":"2.0","method":"x"}\n\nnot json\n');
  });

  it("does not double the newline of a serialize() result", async () => {
    const out = new PassThrough();
    const text = collect(out);
    await writeLine(out, serialize({ jsonrpc: "2.0", id: 1, result: {} }));
    expect(text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  });

  it("writes non-ASCII text as UTF-8 unchanged", async () => {
    const out = new PassThrough();
    const text = collect(out);
    const line = '{"jsonrpc":"2.0","method":"café 😀 \u200b \u2028"}';
    await writeLine(out, line);
    expect(text()).toBe(`${line}\n`);
  });

  it("rejects a line with an embedded line break and writes nothing", async () => {
    const out = new PassThrough();
    const text = collect(out);
    for (const line of ['{"a":1}\n{"b":2}', "a\rb", "a\r\n", "\n\n", "a\r"]) {
      await expect(writeLine(out, line), JSON.stringify(line)).rejects.toThrow(TypeError);
    }
    expect(text()).toBe("");
  });

  it("resolves only after the stream has flushed the line", async () => {
    const { stream, written, releaseOne } = stalledWritable();
    let done = false;
    const pending = writeLine(stream, "one").then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    expect(written).toEqual([]);
    releaseOne();
    await pending;
    expect(written).toEqual(["one\n"]);
  });

  it("keeps the order of concurrent writes, one chunk per line", async () => {
    const { stream, written, releaseOne, heldCount } = stalledWritable();
    const writes = ["a", "b", "c"].map((line) => writeLine(stream, line));
    while (written.length < 3) {
      await tick();
      expect(heldCount()).toBeLessThanOrEqual(1);
      releaseOne();
    }
    await Promise.all(writes);
    expect(written).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("rejects when the stream is destroyed", async () => {
    const out = new PassThrough();
    out.on("error", () => {});
    out.destroy();
    await expect(writeLine(out, "x")).rejects.toThrow();
  });

  it("rejects when the stream has ended", async () => {
    const out = new PassThrough();
    out.on("error", () => {});
    out.end();
    await expect(writeLine(out, "x")).rejects.toThrow(/write after end/);
  });

  it("rejects when the underlying write fails", async () => {
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EPIPE"));
      },
    });
    out.on("error", () => {});
    await expect(writeLine(out, "x")).rejects.toThrow("EPIPE");
  });
});

/** Feed `chunks` into readFrames and collect every frame until the input ends. */
async function framesOf(chunks: Array<string | Buffer>): Promise<Frame[]> {
  const input = new PassThrough();
  const frames: Frame[] = [];
  readFrames(input, (frame) => frames.push(frame));
  const ended = new Promise((resolve) => input.on("end", resolve));
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await ended;
  await tick();
  return frames;
}

describe("readFrames", () => {
  it("delivers each line in order as a parsed frame", async () => {
    const frames = await framesOf(['{"jsonrpc":"2.0","id":1,"method":"a"}\nnot json\n\n{"jsonrpc":"2.0","method":"b"}\n']);
    expect(frames).toEqual([
      { raw: '{"jsonrpc":"2.0","id":1,"method":"a"}', message: { jsonrpc: "2.0", id: 1, method: "a" } },
      { raw: "not json", message: null },
      { raw: "", message: null },
      { raw: '{"jsonrpc":"2.0","method":"b"}', message: { jsonrpc: "2.0", method: "b" } },
    ]);
  });

  it("reassembles lines split across chunks, including inside a UTF-8 character", async () => {
    const line = '{"jsonrpc":"2.0","method":"caf\u00e9 😀"}';
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const emoji = bytes.indexOf(Buffer.from("😀", "utf8"));
    const frames = await framesOf([bytes.subarray(0, 5), bytes.subarray(5, emoji + 2), bytes.subarray(emoji + 2)]);
    expect(frames.map((f) => f.raw)).toEqual([line]);
    expect(frames[0]!.message).toEqual({ jsonrpc: "2.0", method: "caf\u00e9 😀" });
  });

  it("delivers a final line that has no terminator", async () => {
    const frames = await framesOf(['{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"last"}']);
    expect(frames.map((f) => f.raw)).toEqual(['{"jsonrpc":"2.0","method":"a"}', '{"jsonrpc":"2.0","method":"last"}']);
  });

  it("treats CRLF as one terminator, even when split across chunks", async () => {
    const frames = await framesOf(['{"jsonrpc":"2.0","method":"a"}\r', '\n{"jsonrpc":"2.0","method":"b"}\r\n']);
    expect(frames.map((f) => f.raw)).toEqual(['{"jsonrpc":"2.0","method":"a"}', '{"jsonrpc":"2.0","method":"b"}']);
  });

  it("stops delivering frames once closed, even lines already buffered", async () => {
    const input = new PassThrough();
    const raws: string[] = [];
    const close = readFrames(input, (frame) => {
      raws.push(frame.raw);
      if (frame.raw === "b") close();
    });
    input.write("a\nb\nc\nd\n");
    input.write("e\n");
    await tick();
    expect(raws).toEqual(["a", "b"]);
    close();
  });

  it("does not turn an input error into an uncaught exception", async () => {
    const input = new PassThrough();
    const seen: Error[] = [];
    input.on("error", (error) => seen.push(error));
    const frames: Frame[] = [];
    readFrames(input, (frame) => frames.push(frame));
    input.write("a\n");
    await tick();
    input.destroy(new Error("boom"));
    await tick();
    expect(seen.map((e) => e.message)).toEqual(["boom"]);
    expect(frames.map((f) => f.raw)).toEqual(["a"]);
  });

  it("round-trips lines byte-for-byte through writeLine, unknown fields included", async () => {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"x","x-extra":{"kept":true}}',
      "not json",
      "",
      '  {"jsonrpc" : "2.0", "id":"a" ,"result":{"_meta":{"v":1.50},"text":"caf\\u00e9 \u200b"}}  ',
      '[{"jsonrpc":"2.0","id":2,"method":"batch"}]',
    ];
    const input = new PassThrough();
    const output = new PassThrough();
    const text = collect(output);
    const writes: Promise<void>[] = [];
    readFrames(input, (frame) => writes.push(writeLine(output, frame.raw)));
    const ended = new Promise((resolve) => input.on("end", resolve));
    input.end(lines.map((line) => `${line}\n`).join(""));
    await ended;
    await Promise.all(writes);
    expect(writes).toHaveLength(lines.length);
    expect(text()).toBe(lines.map((line) => `${line}\n`).join(""));
  });
});

/** Run a node script as the upstream server and collect its stdout lines and exit code. */
async function runNode(script: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
  const child = spawnUpstream(process.execPath, ["-e", script, ...args], env);
  const raws: string[] = [];
  readFrames(child.stdout, (frame) => raws.push(frame.raw));
  const [code] = (await once(child, "close")) as [number | null];
  return { child, raws, code };
}

describe("serverEnvironment", () => {
  it("merges env over the base and drops LATCH_* variables in any case", () => {
    const base = { PATH: "/bin", LATCH_LLM_API_KEY: "k", Latch_State_Dir: "/s", HOME: "/h" };
    expect(serverEnvironment(base, { API_TOKEN: "t", LATCH_LOCKFILE_PATH: "/l", HOME: undefined })).toEqual({ PATH: "/bin", API_TOKEN: "t" });
    expect(base).toHaveProperty("LATCH_LLM_API_KEY", "k");
  });

  it("copies the base when no env is given", () => {
    expect(serverEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});

describe("spawnUpstream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("carries JSON-RPC lines both ways over the child's stdio", async () => {
    const echo =
      'require("readline").createInterface({ input: process.stdin }).on("line", (l) => process.stdout.write(l + "\\n"));';
    const child: ChildProcessWithoutNullStreams = spawnUpstream(process.execPath, ["-e", echo]);
    const frames: Frame[] = [];
    readFrames(child.stdout, (frame) => frames.push(frame));
    const lines = ['{"jsonrpc":"2.0","id":1,"method":"initialize","x-extra":1}', "not json"];
    for (const line of lines) await writeLine(child.stdin, line);
    child.stdin.end();
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(0);
    expect(frames.map((f) => f.raw)).toEqual(lines);
    expect(frames[0]!.message).toMatchObject({ method: "initialize", "x-extra": 1 });
  });

  it("copies the child's stderr to ours and keeps it off stdout", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(Buffer.from(chunk).toString("utf8"));
      return true;
    });
    const { raws, code } = await runNode('process.stderr.write("diag: caf\u00e9\\n"); console.log("{}")');
    expect(code).toBe(0);
    expect(written.join("")).toBe("diag: caf\u00e9\n");
    expect(raws).toEqual(["{}"]);
  });

  it("passes arguments literally, without a shell", async () => {
    const hostile = "$(echo pwned); `id` | cat > /dev/null && echo 'x' \"y\" *";
    const { raws } = await runNode("console.log(JSON.stringify(process.argv.slice(1)))", [hostile, ""]);
    expect(JSON.parse(raws[0]!)).toEqual([hostile, ""]);
  });

  it("inherits our environment when env is omitted", async () => {
    vi.stubEnv("MCP_TEST_INHERITED", "yes");
    const { raws } = await runNode("console.log(process.env.MCP_TEST_INHERITED)");
    expect(raws).toEqual(["yes"]);
  });

  it("merges env over our environment, and undefined removes a variable", async () => {
    vi.stubEnv("MCP_TEST_INHERITED", "yes");
    vi.stubEnv("MCP_TEST_REMOVED", "yes");
    const { raws } = await runNode(
      "const e = process.env; console.log(JSON.stringify([e.MCP_TEST_INHERITED, e.MCP_TEST_ADDED, e.MCP_TEST_REMOVED ?? null]))",
      [],
      { MCP_TEST_ADDED: "1", MCP_TEST_REMOVED: undefined },
    );
    expect(JSON.parse(raws[0]!)).toEqual(["yes", "1", null]);
  });

  it("keeps LatchVerify's own LATCH_* variables from the server, inherited or given", async () => {
    vi.stubEnv("LATCH_LLM_API_KEY", "secret-key");
    vi.stubEnv("LATCH_LOCKFILE_PATH", "/home/user/latch.lock");
    vi.stubEnv("MCP_TEST_INHERITED", "yes");
    const { raws } = await runNode(
      "console.log(JSON.stringify(Object.keys(process.env).filter((k) => /^latch_|^MCP_TEST_/i.test(k)).sort()))",
      [],
      { LATCH_STATE_DIR: "/home/user/.latch", latch_lower: "x", MCP_TEST_ADDED: "1" },
    );
    expect(JSON.parse(raws[0]!)).toEqual(["MCP_TEST_ADDED", "MCP_TEST_INHERITED"]);
  });

  it("reports a missing command as an error event instead of throwing", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    expect(() => {
      child = spawnUpstream("latch-no-such-binary-for-test", []);
    }).not.toThrow();
    const [error] = (await once(child!, "error")) as [NodeJS.ErrnoException];
    expect(error.code).toBe("ENOENT");
  });

  it("reports the child's exit code", async () => {
    const { code } = await runNode("process.exit(3)");
    expect(code).toBe(3);
  });
});
