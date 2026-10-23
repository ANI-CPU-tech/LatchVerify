import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Output of one demo server run. */
export interface ServerRun {
  /** Every stdout line, parsed: stdout must carry nothing but JSON-RPC. */
  messages: Array<Record<string, unknown>>;
  stderr: string;
  code: number | null;
}

/**
 * Run a demo server script under tsx, feed it `lines` on stdin, close stdin, and collect the
 * output. `between` runs after each line is written, with the pid and the stdout so far, so a
 * test can wait for a reply or signal the server mid-session.
 */
export async function runServer(
  script: string,
  lines: string[],
  options: { env?: NodeJS.ProcessEnv; between?: (index: number, pid: number, stdout: () => string) => Promise<void> } = {},
): Promise<ServerRun> {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = once(child, "close") as Promise<[number | null]>;
  for (const [index, line] of lines.entries()) {
    child.stdin.write(`${line}\n`);
    await options.between?.(index, child.pid!, () => stdout);
  }
  child.stdin.end();
  const [code] = await closed;
  const messages = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { messages, stderr, code };
}

/** One JSON-RPC request line. */
export const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
