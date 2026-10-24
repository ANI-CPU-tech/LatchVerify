import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeToolList } from "../../src/proxy/analysis.js";
import { LockFileSchema, type McpTool } from "../../src/schema/index.js";

// picocolors decides once, when first loaded, whether to colour (it does under CI, as on GitHub
// Actions). This file loads review.js with colour forced on; vitest gives each file fresh modules.
process.env.FORCE_COLOR = "1";
const { renderChange } = await import("../../src/commands/review.js");

const root = fileURLToPath(new URL("../..", import.meta.url));
const lock = LockFileSchema.parse(JSON.parse(readFileSync(join(root, "latch.lock.example"), "utf8")));
const poisoned: McpTool[] = JSON.parse(readFileSync(join(root, "tests/fixtures/poisoned-tools.json"), "utf8")).tools;

describe("renderChange in a colour terminal", () => {
  it("colours the capability delta instead of escaping its colour codes", () => {
    const changes = analyzeToolList("weather", { tools: poisoned }, lock, "2025-06-18", new Date())!.changes.map((c) => c.change);
    for (const change of changes) {
      const card = renderChange(change, lock);
      expect(card, change.toolName).not.toContain("[U+001B]");
      expect(card).toContain("\x1b[");
    }
    const readConfig = renderChange(changes[1]!, lock);
    expect(readConfig).toContain("\x1b[31mgained filesystem.read\x1b[39m; \x1b[33mloosened filesystem.scope\x1b[39m");
  });
});
