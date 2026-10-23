import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** Last commit that touched latch.lock. */
export interface LockfileCommit {
  hash: string;
  /** Committer date, ISO 8601. */
  date: string;
  subject: string;
}

/**
 * Git state of latch.lock, as GET /api/lockfile/git returns it. Approving a change rewrites
 * latch.lock; the approval only reaches CI once that file is committed, so the review UI shows
 * whether it is.
 */
export type LockfileGitStatus =
  | { available: false; reason: string }
  | { available: true; tracked: boolean; modified: boolean; lastCommit: LockfileCommit | null };

/** Long enough for a large repository's status; short enough that the page never hangs. */
const GIT_TIMEOUT_MS = 5_000;

interface GitResult {
  code: number;
  stdout: string;
}

/**
 * Runs one read-only git command in `cwd`. Resolves with the exit code instead of rejecting on a
 * non-zero exit; rejects when git cannot run at all (ENOENT) or times out.
 */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolveRun, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        // Never prompt, and never take the index lock: a commit running at the same time must not fail.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (error === null) return resolveRun({ code: 0, stdout });
        if (typeof error.code === "number") return resolveRun({ code: error.code, stdout });
        reject(error);
      },
    );
  });
}

/**
 * Whether latch.lock is tracked, has uncommitted changes, and its last commit. Read-only.
 * Resolves `{ available: false }` when git is not installed or the file is not in a work tree.
 */
export async function lockfileGitStatus(lockfilePath: string): Promise<LockfileGitStatus> {
  const absolute = resolve(lockfilePath);
  const dir = dirname(absolute);
  const file = basename(absolute);
  try {
    const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { available: false, reason: "latch.lock is not inside a git work tree" };
    }
    const [listed, status, log] = await Promise.all([
      git(dir, ["ls-files", "--error-unmatch", "--", file]),
      git(dir, ["status", "--porcelain=v1", "--untracked-files=all", "--", file]),
      git(dir, ["log", "-1", "--format=%H%x00%cI%x00%s", "--", file]),
    ]);
    if (status.code !== 0) return { available: false, reason: "git status failed for latch.lock" };
    const [hash, date, subject] = log.code === 0 ? log.stdout.trim().split("\0") : [];
    return {
      available: true,
      tracked: listed.code === 0,
      modified: status.stdout.trim() !== "",
      lastCommit: hash && date && subject !== undefined ? { hash, date, subject } : null,
    };
  } catch (error) {
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { available: false, reason: missing ? "git is not installed" : "git did not answer in time" };
  }
}
