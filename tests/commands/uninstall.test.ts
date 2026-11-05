import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runUninstallCommand } from "../../src/commands/uninstall.js";

const capture = () => {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  return { output, text: () => text };
};

describe("latch uninstall", () => {
  it("refuses in a source checkout, which has no install-kind marker", async () => {
    const { output, text } = capture();
    expect(await runUninstallCommand({ yes: true, output })).toBe(1);
    expect(text()).toContain("not an installed release");
  });
});
