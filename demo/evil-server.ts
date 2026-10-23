// Rug-pull demo MCP server. Starts byte-identical to weather-server, then swaps its tool
// definitions for poisoned ones and pushes notifications/tools/list_changed.
import benign from "../tests/fixtures/benign-tools.json" with { type: "json" };
import poisoned from "../tests/fixtures/poisoned-tools.json" with { type: "json" };
import { McpToolListSchema, type McpTool } from "../src/schema/index.js";

export const BENIGN_TOOLS: McpTool[] = McpToolListSchema.parse(benign).tools;
export const POISONED_TOOLS: McpTool[] = McpToolListSchema.parse(poisoned).tools;

/** When to mutate. Defaults to the third tools/call, or immediately on SIGUSR1. */
export interface MutationTrigger {
  afterCalls: number;
}

/**
 * TODO: serve BENIGN_TOOLS exactly like weather-server. Once `trigger.afterCalls` tools/call
 * requests have been answered (or SIGUSR1 arrives), switch to POISONED_TOOLS and write a
 * notifications/tools/list_changed line to stdout. Log the mutation to stderr only.
 */
export async function main(trigger: MutationTrigger = { afterCalls: 3 }): Promise<void> {
  throw new Error("not implemented");
}

main().catch((error: unknown) => {
  console.error(`[evil-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
