import { z } from "zod";
import { Sha256HexSchema, ToolRecordSchema } from "./tool.js";

/** Current latch.lock format version. Bump on breaking format changes. */
export const LOCKFILE_VERSION = "1";

export const TransportSchema = z.enum(["stdio", "http"]);
export type Transport = z.infer<typeof TransportSchema>;

/**
 * One upstream MCP server and its approved tools. latch.lock is committed to git, so it never holds
 * a server's launch line: arguments may carry a key (`--token ...`). It keeps the program's name
 * for people and a hash that ties the pins to exactly one launch (analyze/hash.ts launchHash).
 */
export const ServerEntrySchema = z.object({
  transport: TransportSchema,
  /** The program the server runs, for people: "npx", "uvx", "node". Never a path or an argument. */
  program: z.string().min(1),
  /** sha256 of the canonical JSON of [command, ...args]: the launch these pins belong to. */
  launch: Sha256HexSchema,
  tools: z.array(ToolRecordSchema),
  /**
   * Linked but not run yet: the proxy pins the tools the first time the server lists them (trust
   * on first use), holding back any with critical findings, and then removes this flag. Linking
   * never starts a server itself, so it never handles the keys in the client's config.
   */
  trustOnFirstUse: z.literal(true).optional(),
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
