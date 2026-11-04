import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

// Apart from ui/server.ts, so the commands that record approvals or pins (init, add, the
// background sync) do not load the review UI's HTTP server to find out who the user is.

/** `git config user.email` in the current directory, or undefined when git or the setting is missing. */
function gitUserEmail(): string | undefined {
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
    return email.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Who approvals are recorded as: LATCH_REVIEWER, else the git user.email, else the OS user name. */
export function defaultReviewer(env: NodeJS.ProcessEnv = process.env): string {
  return env.LATCH_REVIEWER?.trim() || gitUserEmail() || userInfo().username;
}
