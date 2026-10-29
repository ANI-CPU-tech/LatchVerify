import { z } from "zod";
import { SUPPORTED_CLIENTS } from "../config/client-ids.js";

/**
 * GET /api/clients: the MCP clients found on this machine, per client, for the dashboard. It holds
 * names, file paths, counts and states only: never a server's arguments or env, which may hold keys.
 */

/** One stdio server of a client, as the dashboard shows it. */
export const ClientServerStateSchema = z.object({
  id: z.string(),
  /** The program it runs ("npx"): never its arguments. */
  program: z.string(),
  /** True when the client starts it through latch proxy. */
  linked: z.boolean(),
  /** In latch.lock: pinned, waiting for its first run, or not there. */
  pin: z.enum(["pinned", "first_run", "absent"]),
  /** Tools pinned for it. */
  tools: z.number().int().nonnegative(),
});
export type ClientServerState = z.infer<typeof ClientServerStateSchema>;

export const ClientReportSchema = z.object({
  id: z.enum(SUPPORTED_CLIENTS),
  name: z.string(),
  /** The user's answer: connected, declined (said no or disconnected), or never asked. */
  answer: z.enum(["connected", "declined", "unasked"]),
  /** The config files the client keeps servers in; scope names a part of one ("project /srv/app"). */
  files: z.array(z.object({ path: z.string(), scope: z.string().optional() })),
  servers: z.array(ClientServerStateSchema),
  /** Why a file of this client could not be used; it is left untouched. */
  problems: z.array(z.string()),
});
export type ClientReport = z.infer<typeof ClientReportSchema>;

export const ClientsReportSchema = z.object({ clients: z.array(ClientReportSchema) });
export type ClientsReport = z.infer<typeof ClientsReportSchema>;
