export interface InspectOptions {
  /** Path to a JSON file containing a tools/list result; mutually exclusive with `server`. */
  file?: string;
  /** Command line of a live server to query instead. */
  server?: string[];
  json: boolean;
}

/**
 * `latch inspect`
 * TODO: load tools from the file or spawn the server, then print each tool's derived capability
 * set, declared annotations and detector findings without touching the lockfile. Read-only; the
 * "what would latch think of this server" command. Resolves with the process exit code.
 */
export async function runInspect(options: InspectOptions): Promise<number> {
  throw new Error("not implemented");
}
