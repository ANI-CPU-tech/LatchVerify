import { describe, expect, it } from "vitest";
import { parseJsonc, setJsonc } from "../../src/config/jsonc.js";

describe("parseJsonc", () => {
  it("reads plain JSON like JSON.parse", () => {
    const text = '{"a": [1, "two", true, null, {"b": 2.5}], "c": {}}';
    expect(parseJsonc(text)).toEqual({ ok: true, value: JSON.parse(text) });
  });

  it("reads comments and trailing commas", () => {
    const text = `{
  // servers
  "servers": { /* inline */ "a": { "command": "x", }, },
}`;
    expect(parseJsonc(text)).toEqual({ ok: true, value: { servers: { a: { command: "x" } } } });
  });

  it("accepts a leading byte-order mark", () => {
    expect(parseJsonc('﻿{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("keeps a __proto__ key as a plain property", () => {
    const result = parseJsonc('{"__proto__": {"polluted": true}}');
    expect(result.ok).toBe(true);
    const value = (result as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("keeps the last value of a repeated key, as JSON.parse does", () => {
    expect(parseJsonc('{"a": 1, "a": 2}')).toEqual({ ok: true, value: { a: 2 } });
  });

  it("says where the first error is", () => {
    expect(parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toEqual({ ok: false, error: "CommaExpected at line 3, column 3" });
    expect(parseJsonc("")).toEqual({ ok: false, error: "ValueExpected at line 1, column 1" });
    expect(parseJsonc("   ")).toMatchObject({ ok: false });
  });
});

describe("setJsonc", () => {
  const text = `{
    // the user's servers
    "servers": {
        "a": { "command": "x" }, // keep me
        /* and me */
        "b": { "command": "y" },
    },
    "other": [1, 2,],
}
`;

  it("changes only the edited value, keeping every comment and trailing comma", () => {
    const next = setJsonc(text, ["servers", "a"], { command: "latch", args: ["proxy"] });
    expect(next).toContain("// the user's servers");
    expect(next).toContain("// keep me");
    expect(next).toContain("/* and me */");
    expect(next).toContain('"b": { "command": "y" },');
    expect(next).toContain('"other": [1, 2,],');
    expect(parseJsonc(next)).toEqual({ ok: true, value: { servers: { a: { command: "latch", args: ["proxy"] }, b: { command: "y" } }, other: [1, 2] } });
  });

  it("adds a missing key and its parents", () => {
    const next = setJsonc('{\n  "theme": "dark" // mine\n}\n', ["context_servers", "a"], { command: "x" });
    // A comment closing the line before the insertion point moves after the new value; it is never lost.
    expect(next).toBe('{\n  "theme": "dark",\n  "context_servers": {\n    "a": {\n      "command": "x"\n    }\n  } // mine\n}\n');
    expect(parseJsonc(next)).toEqual({ ok: true, value: { theme: "dark", context_servers: { a: { command: "x" } } } });
  });

  it("lays out the new value with the file's indentation and line endings", () => {
    const tabs = setJsonc('{\r\n\t"servers": {}\r\n}\r\n', ["servers", "a"], { command: "x" });
    expect(tabs).toBe('{\r\n\t"servers": {\r\n\t\t"a": {\r\n\t\t\t"command": "x"\r\n\t\t}\r\n\t}\r\n}\r\n');
    const four = setJsonc('{\n    "servers": {}\n}', ["servers", "a"], { command: "x" });
    expect(four).toBe('{\n    "servers": {\n        "a": {\n            "command": "x"\n        }\n    }\n}');
  });

  it("is plain JSON in, plain JSON out", () => {
    const next = setJsonc('{"servers": {"a": {"command": "x"}}}', ["servers", "a", "command"], "y");
    expect(JSON.parse(next)).toEqual({ servers: { a: { command: "y" } } });
  });
});
