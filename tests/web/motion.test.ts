import { describe, expect, it } from "vitest";
import { countFrame, easeOutCubic } from "../../web/src/lib/motion.js";

describe("easeOutCubic", () => {
  it("runs from 0 to 1, fast at first, and clamps outside the range", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("countFrame", () => {
  it("counts in whole numbers and lands exactly on the target", () => {
    expect(countFrame(0, 102, 0, 700)).toBe(0);
    expect(countFrame(0, 102, 350, 700)).toBe(89);
    expect(countFrame(0, 102, 700, 700)).toBe(102);
    expect(countFrame(0, 102, 9999, 700)).toBe(102);
  });

  it("counts down as well, and jumps when there is no time", () => {
    expect(countFrame(10, 4, 350, 700)).toBe(5);
    expect(countFrame(10, 4, 0, 0)).toBe(4);
  });
});
