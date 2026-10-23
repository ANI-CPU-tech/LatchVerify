import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { createInterface } from "node:readline";

/** Receives one line of build output. */
export type Log = (line: string) => void;

/**
 * Environment the build tools see: the variables they need to find themselves, the pnpm store
 * and a temp directory. Everything else (API tokens, cloud credentials, LATCH_* settings) is
 * left out, so nothing secret can end up in a package or a build log.
 */
const PASSED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "PNPM_HOME",
  "SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC", "ComSpec", "TEMP", "TMP", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
];

export function buildEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENV) if (source[name] !== undefined) env[name] = source[name];
  return { ...env, ...extra };
}

/** Full path of `command` on PATH, or null. Never runs anything. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: Log;
  /** Kills the process after this long. Default 15 minutes. */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `command` with `args` directly (no shell, so no argument is ever interpreted) and
 * resolves with its exit code and output. Lines go to `log` as they arrive.
 */
export function capture(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? buildEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    const err: string[] = [];
    const follow = (stream: NodeJS.ReadableStream, sink: string[]) =>
      createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
        sink.push(line);
        options.log?.(line);
      });
    follow(child.stdout, out);
    follow(child.stderr, err);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 15 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout: out.join("\n"), stderr: err.join("\n") });
    });
  });
}

/** Like capture(), but rejects on a non-zero exit with the command and its last output lines. */
export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  options.log?.(`$ ${[command, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`);
  const result = await capture(command, args, options);
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).split("\n").slice(-5).join("\n");
    throw new Error(`${command} exited with status ${result.code}${tail ? `:\n${tail}` : ""}`);
  }
  return result;
}

/** How to run pnpm: [command, ...leading args]. Prefers the pnpm that started this process. */
export function resolvePnpm(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const execPath = env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) {
    return [".js", ".cjs", ".mjs"].includes(extname(execPath)) ? [process.execPath, execPath] : [execPath];
  }
  // A Windows pnpm.cmd cannot be spawned without a shell; there, run through `pnpm ui` / `pnpm package`.
  const found = which("pnpm", env);
  return found && extname(found).toLowerCase() !== ".cmd" ? [found] : null;
}
