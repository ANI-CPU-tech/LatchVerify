import { describe, expect, it } from "vitest";
import { navKeyTarget } from "../../web/src/lib/nav.js";

describe("navKeyTarget", () => {
  it("moves down and up the sidebar, wrapping at both ends", () => {
    expect(navKeyTarget("ArrowDown", 0, 8, "sidebar")).toBe(1);
    expect(navKeyTarget("ArrowDown", 7, 8, "sidebar")).toBe(0);
    expect(navKeyTarget("ArrowUp", 3, 8, "sidebar")).toBe(2);
    expect(navKeyTarget("ArrowUp", 0, 8, "sidebar")).toBe(7);
  });

  it("moves left and right in the phone strip", () => {
    expect(navKeyTarget("ArrowRight", 2, 8, "strip")).toBe(3);
    expect(navKeyTarget("ArrowLeft", 0, 8, "strip")).toBe(7);
  });

  it("jumps to the first and last link with Home and End", () => {
    expect(navKeyTarget("Home", 5, 8, "sidebar")).toBe(0);
    expect(navKeyTarget("End", 1, 8, "strip")).toBe(7);
  });

  it("ignores keys off the layout's axis and other keys", () => {
    expect(navKeyTarget("ArrowLeft", 2, 8, "sidebar")).toBeNull();
    expect(navKeyTarget("ArrowDown", 2, 8, "strip")).toBeNull();
    expect(navKeyTarget("Enter", 2, 8, "sidebar")).toBeNull();
    expect(navKeyTarget("ArrowDown", 0, 0, "sidebar")).toBeNull();
  });
});
