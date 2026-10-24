// A minimal stdio MCP server for the installer smoke tests: one harmless tool, no dependencies,
// runnable by any Node.js. Line-delimited JSON-RPC, as the latch proxy speaks it.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Return the text it is given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } });
  else if (message.method === "tools/list") reply(message.id, { tools });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] });
  else reply(message.id, {});
});
