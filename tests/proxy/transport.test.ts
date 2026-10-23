import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  isNotification,
  isRequest,
  isResponse,
  parseLine,
  serialize,
  writeLine,
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
