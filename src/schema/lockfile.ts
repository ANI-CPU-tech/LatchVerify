import { z } from "zod";
import { ToolRecordSchema } from "./tool.js";

/** Current latch.lock format version. Bump on breaking format changes. */
export const LOCKFILE_VERSION = "1";

export const TransportSchema = z.enum(["stdio", "http"]);
export type Transport = z.infer<typeof TransportSchema>;

/** One upstream MCP server and its approved tools. */
export const ServerEntrySchema = z.object({
  transport: TransportSchema,
  /** Executable (stdio) or base URL (http) of the real server. */
  command: z.string().min(1),
  args: z.array(z.string()),
  tools: z.array(ToolRecordSchema),
});
export type ServerEntry = z.infer<typeof ServerEntrySchema>;

/** latch.lock: approved tool state, committed to git. */
export const LockFileSchema = z
  .object({
    version: z.string().min(1),
    generatedAt: z.iso.datetime(),
    servers: z.record(z.string().min(1), ServerEntrySchema),
  })
  .superRefine((lock, ctx) => {
    for (const [serverId, server] of Object.entries(lock.servers)) {
      const seen = new Set<string>();
      server.tools.forEach((tool, i) => {
        // A tool's serverId must match the key it is filed under.
        if (tool.serverId !== serverId) {
          ctx.addIssue({
            code: "custom",
            path: ["servers", serverId, "tools", i, "serverId"],
            message: `serverId "${tool.serverId}" does not match server key "${serverId}"`,
          });
        }
        if (seen.has(tool.name)) {
          ctx.addIssue({
            code: "custom",
            path: ["servers", serverId, "tools", i, "name"],
            message: `duplicate tool "${tool.name}" in server "${serverId}"`,
          });
        }
        seen.add(tool.name);
      });
    }
  });
export type LockFile = z.infer<typeof LockFileSchema>;
