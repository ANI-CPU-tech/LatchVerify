import { describe, expect, it } from "vitest";
import { listboxKey, typeaheadIndex } from "../../web/src/lib/listbox.js";

describe("listboxKey", () => {
  it("moves the highlight without wrapping, and jumps to the ends", () => {
    expect(listboxKey("ArrowDown", 1, 3)).toEqual({ kind: "move", to: 2 });
    expect(listboxKey("ArrowDown", 2, 3)).toEqual({ kind: "move", to: 2 });
    expect(listboxKey("ArrowUp", 0, 3)).toEqual({ kind: "move", to: 0 });
    expect(listboxKey("Home", 2, 3)).toEqual({ kind: "move", to: 0 });
    expect(listboxKey("End", 0, 3)).toEqual({ kind: "move", to: 2 });
  });

  it("chooses with Enter or Space and closes with Escape or Tab", () => {
    expect(listboxKey("Enter", 1, 3)).toEqual({ kind: "choose" });
    expect(listboxKey(" ", 1, 3)).toEqual({ kind: "choose" });
    expect(listboxKey("Escape", 1, 3)).toEqual({ kind: "close" });
    expect(listboxKey("Tab", 1, 3)).toEqual({ kind: "close" });
  });

  it("ignores other keys, and only closes an empty list", () => {
    expect(listboxKey("a", 1, 3)).toBeNull();
    expect(listboxKey("ArrowDown", 0, 0)).toBeNull();
    expect(listboxKey("Escape", 0, 0)).toEqual({ kind: "close" });
  });
});

describe("typeaheadIndex", () => {
  const labels = ["All servers", "evil", "filesystem", "github", "Evening"];

  it("finds the next label starting with the letter, case-insensitively, wrapping around", () => {
    expect(typeaheadIndex(labels, "e", 0)).toBe(1);
    expect(typeaheadIndex(labels, "E", 1)).toBe(4);
    expect(typeaheadIndex(labels, "e", 4)).toBe(1);
    expect(typeaheadIndex(labels, "a", 2)).toBe(0);
  });

  it("returns null for no match or a key that is not one character", () => {
    expect(typeaheadIndex(labels, "z", 0)).toBeNull();
    expect(typeaheadIndex(labels, "ArrowDown", 0)).toBeNull();
    expect(typeaheadIndex(labels, " ", 0)).toBeNull();
  });
});
