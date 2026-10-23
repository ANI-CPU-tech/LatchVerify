// Benign demo MCP server: two read-only weather tools over stdio.
// Speaks raw line-delimited JSON-RPC, like the proxy, so the demo has no SDK dependency.
import benign from "../tests/fixtures/benign-tools.json" with { type: "json" };
import { McpToolListSchema, type McpTool } from "../src/schema/index.js";

export const TOOLS: McpTool[] = McpToolListSchema.parse(benign).tools;

/**
 * TODO: readline over stdin; answer `initialize` (protocolVersion "2025-06-18", capabilities
 * { tools: { listChanged: true } }), `tools/list` with TOOLS, and `tools/call` with canned
 * forecast/alert text. Unknown methods get JSON-RPC error -32601.
 */
export async function main(): Promise<void> {
  throw new Error("not implemented");
}

main().catch((error: unknown) => {
  console.error(`[weather-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
