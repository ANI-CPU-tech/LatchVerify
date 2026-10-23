import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MAX_CANONICAL_DEPTH, canonicalJson, hashTool, sha256Hex } from "../../src/analyze/hash.js";
import {
  LockFileSchema,
  McpToolListSchema,
  Sha256HexSchema,
  ToolHashesSchema,
  type McpTool,
} from "../../src/schema/index.js";

const fixtureTools = (name: string) =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

/** Same value with every object's keys inserted in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

/** `depth` arrays nested inside each other. */
const nestedArrays = (depth: number): unknown => {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
};

describe("canonicalJson", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    for (const tool of [...fixtureTools("benign-tools.json"), ...fixtureTools("poisoned-tools.json")]) {
      expect(canonicalJson(reverseKeys(tool))).toBe(canonicalJson(tool));
    }
  });

  it("preserves array order", () => {
    expect(canonicalJson(["b", "a", 2, 1])).toBe('["b","a",2,1]');
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  it("serializes primitives exactly like JSON.stringify", () => {
    for (const value of [null, true, false, 0, -0, 1, -1.5, 0.1, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, "", "plain"]) {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
  });

  it("escapes strings like JSON.stringify and leaves non-ASCII text raw", () => {
    const text = 'quote " backslash \\ newline \n tab \t nul \u0000 é 😀 zero-width \u200b';
    expect(canonicalJson(text)).toBe(JSON.stringify(text));
    expect(canonicalJson("é😀")).toBe('"é😀"');
  });

  it("escapes lone surrogates so distinct strings stay distinct", () => {
    expect(canonicalJson("\ud800")).toBe('"\\ud800"');
    expect(canonicalJson("\ud800")).not.toBe(canonicalJson("\ufffd"));
  });

  it("orders keys by UTF-16 code units (RFC 8785), not by code point", () => {
    // U+1F600 is stored as \ud83d\ude00, which sorts before U+FF61 by code unit.
    expect(canonicalJson({ "\uff61": 1, "\u{1f600}": 2, a: 3 })).toBe('{"a":3,"\u{1f600}":2,"\uff61":1}');
  });

  it("round-trips the fixtures without losing data", () => {
    for (const tool of fixtureTools("poisoned-tools.json")) {
      expect(JSON.parse(canonicalJson(tool))).toEqual(tool);
    }
  });

  it("omits undefined members and writes undefined or missing array slots as null", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, , 1])).toBe("[null,null,1]");
  });

  it("serializes an own __proto__ key as data", () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"a":2}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it("accepts null-prototype objects and repeated (non-cyclic) references", () => {
    const shared = { k: 1 };
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    expect(canonicalJson({ x: shared, y: shared, z: bare })).toBe('{"x":{"k":1},"y":{"k":1},"z":{"a":1,"b":2}}');
  });

  it("rejects values JSON cannot represent", () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("s")]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson([1n])).toThrow(TypeError);
  });

  it("rejects non-plain objects instead of silently serializing them as {}", () => {
    class Custom {
      a = 1;
    }
    for (const value of [new Date(0), new Map([["a", 1]]), new Set([1]), new Custom(), /re/]) {
      expect(() => canonicalJson({ nested: value })).toThrow(/unsupported object type/);
    }
  });

  it("rejects cyclic structures", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalJson(obj)).toThrow(/cyclic/);
    expect(() => canonicalJson(arr)).toThrow(/cyclic/);
  });

  it(`accepts ${MAX_CANONICAL_DEPTH} levels of nesting and rejects one more`, () => {
    expect(() => canonicalJson(nestedArrays(MAX_CANONICAL_DEPTH))).not.toThrow();
    expect(() => canonicalJson(nestedArrays(MAX_CANONICAL_DEPTH + 1))).toThrow(RangeError);
  });

  it("does not mutate its input", () => {
    const value = { b: [2, 1], a: { d: 1, c: 2 } };
    const before = structuredClone(value);
    canonicalJson(value);
    expect(value).toEqual(before);
    expect(Object.keys(value)).toEqual(["b", "a"]);
  });
});

describe("sha256Hex", () => {
  it("matches published SHA-256 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes well-formed text as UTF-8", () => {
    // Reference digests from `printf 'é' | sha256sum` and `printf '😀' | sha256sum`.
    expect(sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
    expect(sha256Hex("😀")).toBe("f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9");
  });

  it("returns a lowercase 64-character hex digest accepted by Sha256HexSchema", () => {
    for (const input of ["", "abc", "\u200b", "\ud800", "x".repeat(100_000)]) {
      expect(Sha256HexSchema.safeParse(sha256Hex(input)).success).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(sha256Hex("same input")).toBe(sha256Hex("same input"));
  });

  it("does not normalize Unicode, so invisible or composed variants hash differently", () => {
    expect(sha256Hex("forecast")).not.toBe(sha256Hex("fore\u200bcast"));
    expect(sha256Hex("\u00e9")).not.toBe(sha256Hex("e\u0301")); // NFC vs NFD é
  });

  it("keeps lone surrogates distinct from U+FFFD and from their escaped text", () => {
    const lone = sha256Hex("\ud800");
    expect(lone).not.toBe(sha256Hex("\ufffd"));
    expect(lone).not.toBe(sha256Hex('"\\ud800"'));
    expect(lone).not.toBe(sha256Hex("\udc00"));
    // A valid surrogate pair is well-formed and takes the plain UTF-8 path.
    expect(sha256Hex("\ud83d\ude00")).toBe(sha256Hex("😀"));
  });

  it("hashes ill-formed strings as 0xFF followed by their JSON-escaped UTF-8", () => {
    const input = "a\ud800b";
    const expected = createHash("sha256")
      .update(Uint8Array.of(0xff))
      .update(JSON.stringify(input), "utf8")
      .digest("hex");
    expect(sha256Hex(input)).toBe(expected);
  });
});

describe("hashTool", () => {
  const benign = fixtureTools("benign-tools.json");
  const poisoned = fixtureTools("poisoned-tools.json");
  const forecast = benign.find((t) => t.name === "get_forecast")!;

  /** Deep copy of `tool` with overrides applied. */
  const variant = (tool: McpTool, overrides: Partial<McpTool>): McpTool => ({ ...structuredClone(tool), ...overrides });

  /** Freeze recursively so any mutation throws in strict mode. */
  const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it("reproduces every segment hash pinned in latch.lock.example", () => {
    const lock = LockFileSchema.parse(
      JSON.parse(readFileSync(new URL("../../latch.lock.example", import.meta.url), "utf8")),
    );
    const pinned = lock.servers.weather?.tools ?? [];
    expect(pinned.map((r) => r.name).sort()).toEqual(benign.map((t) => t.name).sort());
    for (const record of pinned) {
      const tool = benign.find((t) => t.name === record.name)!;
      expect(hashTool(tool)).toEqual(record.hashes);
    }
  });

  it("returns hashes that satisfy ToolHashesSchema", () => {
    for (const tool of [...benign, ...poisoned]) {
      expect(ToolHashesSchema.safeParse(hashTool(tool)).success).toBe(true);
    }
  });

  it("derives each segment and the composite as documented", () => {
    const hashes = hashTool(forecast);
    expect(hashes.name).toBe(sha256Hex(forecast.name));
    expect(hashes.description).toBe(sha256Hex(forecast.description!));
    expect(hashes.inputSchema).toBe(sha256Hex(canonicalJson(forecast.inputSchema)));
    expect(hashes.composite).toBe(sha256Hex(`${hashes.name}:${hashes.description}:${hashes.inputSchema}`));
  });

  it("is unchanged when inputSchema keys are reordered", () => {
    for (const tool of [...benign, ...poisoned]) {
      expect(hashTool(reverseKeys(tool) as McpTool)).toEqual(hashTool(tool));
    }
  });

  it("changes only description and composite when one zero-width space is inserted", () => {
    const before = hashTool(forecast);
    const after = hashTool(variant(forecast, { description: forecast.description!.replace("weather", "wea\u200bther") }));
    expect(after.name).toBe(before.name);
    expect(after.inputSchema).toBe(before.inputSchema);
    expect(after.description).not.toBe(before.description);
    expect(after.composite).not.toBe(before.composite);
  });

  it("changes only name and composite when the tool is renamed", () => {
    const before = hashTool(forecast);
    const after = hashTool(variant(forecast, { name: "get_forecast_v2" }));
    expect(after.description).toBe(before.description);
    expect(after.inputSchema).toBe(before.inputSchema);
    expect(after.name).not.toBe(before.name);
    expect(after.composite).not.toBe(before.composite);
  });

  it("changes only inputSchema and composite when a nested constraint is loosened", () => {
    const loosened = structuredClone(forecast);
    loosened.inputSchema.properties = { ...loosened.inputSchema.properties, units: { type: "string" } };
    const before = hashTool(forecast);
    const after = hashTool(loosened);
    expect(after.name).toBe(before.name);
    expect(after.description).toBe(before.description);
    expect(after.inputSchema).not.toBe(before.inputSchema);
    expect(after.composite).not.toBe(before.composite);
  });

  it("treats a missing description as the empty string", () => {
    const { description: _omitted, ...withoutDescription } = forecast;
    expect(hashTool(withoutDescription)).toEqual(hashTool(variant(forecast, { description: "" })));
  });

  it("ignores fields outside the three hashed segments", () => {
    const decorated = variant(forecast, {
      title: "Something else",
      annotations: { readOnlyHint: false, destructiveHint: true },
      "x-vendor-extension": { kept: true },
    });
    expect(hashTool(decorated)).toEqual(hashTool(forecast));
  });

  it("gives every fixture tool a distinct composite and flags the poisoned forecast as changed", () => {
    const composites = [...benign, ...poisoned].map((t) => hashTool(t).composite);
    // get_forecast exists in both fixtures with different content, so all composites differ.
    expect(new Set(composites).size).toBe(composites.length);
    const poisonedForecast = poisoned.find((t) => t.name === "get_forecast")!;
    expect(hashTool(poisonedForecast).name).toBe(hashTool(forecast).name);
    expect(hashTool(poisonedForecast).composite).not.toBe(hashTool(forecast).composite);
  });

  it("does not mutate the tool", () => {
    const frozen = deepFreeze(structuredClone(poisoned[0]!));
    expect(() => hashTool(frozen)).not.toThrow();
    expect(frozen).toEqual(poisoned[0]);
  });

  it("propagates canonicalJson errors for inputSchema values JSON cannot represent", () => {
    const broken = variant(forecast, { inputSchema: { type: "object", properties: { n: { maximum: NaN } } } });
    expect(() => hashTool(broken)).toThrow(TypeError);
  });
});
