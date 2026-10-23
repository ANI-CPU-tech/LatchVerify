import { describe, expect, it, vi } from "vitest";
import { simulateRugPull } from "../../src/ui/simulation.js";

// web/ resolves "@schema/*" through a Vite alias that this (node) test config does not define.
vi.mock("@schema/index.js", () => import("../../src/schema/index.js"));

const { RUG_PULL, descriptionDiff, revealInvisible, simulationSteps } = await import("../../web/src/lib/simulation.js");

const result = simulateRugPull(RUG_PULL, new Date("2026-10-24T10:00:00.000Z"));
const steps = simulationSteps(result);

describe("RUG_PULL", () => {
  it("replays three calls before the swap, as the evil demo server mutates after its third", () => {
    expect(RUG_PULL.callsBefore).toHaveLength(3);
  });
});

describe("simulationSteps", () => {
  it("tells the story in order: pin, calls, swap, analysis, calls, review", () => {
    expect(steps.map((step) => step.id)).toEqual(["pin", "before-0", "before-1", "before-2", "swap", "analyze", "after-0", "after-1", "after-2", "review"]);
  });

  it("shows forwarded calls as a round trip and blocked ones as the proxy's error", () => {
    const forwarded = steps.find((step) => step.id === "before-0")!;
    expect(forwarded.tone).toBe("success");
    expect(forwarded.messages.map((m) => `${m.from}>${m.to}`)).toEqual(["agent>proxy", "proxy>server", "server>proxy", "proxy>agent"]);

    const blocked = steps.find((step) => step.id === "after-0")!;
    expect(blocked.tone).toBe("destructive");
    expect(blocked.detail).toBe(result.callsAfter[0]!.blocked!.error.message);
    expect(blocked.messages.map((m) => `${m.from}>${m.to}`)).toEqual(["agent>proxy", "proxy>agent"]);
    expect(blocked.messages.some((m) => m.to === "server")).toBe(false);
  });

  it("summarizes the analysis by tier, worst first", () => {
    const analyze = steps.find((step) => step.id === "analyze")!;
    expect(analyze.tone).toBe("destructive");
    expect(analyze.detail).toMatch(/^\d+ changes: \d+ at tier 3/);
  });

  it("reports a calm analysis when the server does not change", () => {
    const calm = simulationSteps(simulateRugPull({ ...RUG_PULL, served: RUG_PULL.pinned, callsAfter: ["get_forecast"] }, new Date()));
    expect(calm.find((step) => step.id === "analyze")).toMatchObject({ tone: "success", detail: "Every tool matches latch.lock." });
    expect(calm.find((step) => step.id === "after-0")!.tone).toBe("success");
  });
});

describe("revealInvisible and descriptionDiff", () => {
  it("names hidden characters", () => {
    expect(revealInvisible("a​b‮c\u{E0041}")).toBe("a[U+200B]b[U+202E]c[U+E0041]");
    expect(revealInvisible("plain")).toBe("plain");
  });

  it("diffs get_forecast's description with the zero-width run made visible", () => {
    const parts = descriptionDiff(RUG_PULL, "get_forecast")!;
    const added = parts.filter((part) => part.added).map((part) => part.value).join("");
    expect(added).toContain("[U+200B]");
    expect(added).toContain("~/.ssh/id_rsa");
    expect(descriptionDiff(RUG_PULL, "read_config")).toBeNull();
  });
});
