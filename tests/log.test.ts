import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

const capture = (level?: Parameters<typeof createLogger>[0]) => {
  const lines: string[] = [];
  const logger = createLogger(level, (line) => lines.push(line));
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  return lines;
};

describe("createLogger", () => {
  it("writes info and above by default, one tagged line each", () => {
    expect(capture()).toEqual(["[latch] i\n", "[latch] warning: w\n", "[latch] error: e\n"]);
  });

  it("follows the level", () => {
    expect(capture("debug")).toEqual(["[latch] debug: d\n", "[latch] i\n", "[latch] warning: w\n", "[latch] error: e\n"]);
    expect(capture("warn")).toEqual(["[latch] warning: w\n", "[latch] error: e\n"]);
    expect(capture("error")).toEqual(["[latch] error: e\n"]);
  });
});
