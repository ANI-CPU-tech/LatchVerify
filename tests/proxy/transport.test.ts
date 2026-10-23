import { describe, expect, it } from "vitest";
import { isNotification, isRequest, isResponse, parseLine, type JsonRpcMessage } from "../../src/proxy/transport.js";

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
