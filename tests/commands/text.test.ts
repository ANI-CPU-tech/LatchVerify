import { describe, expect, it } from "vitest";
import { plural, printable } from "../../src/commands/text.js";

describe("printable", () => {
  it("escapes control and format characters but keeps other Unicode", () => {
    expect(printable("café 😀 ok")).toBe("café 😀 ok");
    expect(printable("a\u0000b\nc\u200bd\u2028e\u{e0068}")).toBe("a[U+0000]b[U+000A]c[U+200B]d[U+2028]e[U+E0068]");
  });
});

describe("plural", () => {
  it("adds an s for every count but one", () => {
    expect(plural(1, "tool")).toBe("1 tool");
    expect([0, 2, 10].map((n) => plural(n, "tool"))).toEqual(["0 tools", "2 tools", "10 tools"]);
    expect([1, 3].map((n) => plural(n, "entry", "entries"))).toEqual(["1 entry", "3 entries"]);
  });
});
