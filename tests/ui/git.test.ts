import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockfileGitStatus } from "../../src/ui/git.js";
import { createRoutes } from "../../src/ui/routes.js";

const EXAMPLE_LOCK = new URL("../../latch.lock.example", import.meta.url);

let dir: string;
let lockfilePath: string;

const git = (...args: string[]): string =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-git-"));
  lockfilePath = join(dir, "latch.lock");
  await copyFile(EXAMPLE_LOCK, lockfilePath);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("lockfileGitStatus", () => {
  it("is unavailable outside a git work tree", async () => {
    await expect(lockfileGitStatus(lockfilePath)).resolves.toEqual({ available: false, reason: "latch.lock is not inside a git work tree" });
  });

  it("reports an untracked lockfile as modified with no commit", async () => {
    git("init", "-q");
    await expect(lockfileGitStatus(lockfilePath)).resolves.toEqual({ available: true, tracked: false, modified: true, lastCommit: null });
  });

  it("reports a committed lockfile as clean, with its last commit", async () => {
    git("init", "-q");
    git("add", "latch.lock");
    git("commit", "-q", "-m", "chore: pin weather tools");
    const hash = git("rev-parse", "HEAD").trim();
    const status = await lockfileGitStatus(lockfilePath);
    expect(status).toMatchObject({ available: true, tracked: true, modified: false, lastCommit: { hash, subject: "chore: pin weather tools" } });
    expect(status.available && Number.isNaN(Date.parse(status.lastCommit!.date))).toBe(false);
  });

  it("reports an approval that rewrote the lockfile as modified", async () => {
    git("init", "-q");
    git("add", "latch.lock");
    git("commit", "-q", "-m", "pin");
    await writeFile(lockfilePath, "{}\n");
    await expect(lockfileGitStatus(lockfilePath)).resolves.toMatchObject({ available: true, tracked: true, modified: true });
  });

  it("ignores changes to other files", async () => {
    git("init", "-q");
    git("add", "latch.lock");
    git("commit", "-q", "-m", "pin");
    await writeFile(join(dir, "other.txt"), "x");
    await expect(lockfileGitStatus(lockfilePath)).resolves.toMatchObject({ tracked: true, modified: false });
  });
});

describe("GET /api/lockfile/git", () => {
  it("returns the lockfile's git status as JSON", async () => {
    git("init", "-q");
    const app = createRoutes({ lockfilePath, stateDir: join(dir, ".latch"), reviewer: "alice@example.com" });
    const response = await app.request("/api/lockfile/git");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ available: true, tracked: false, modified: true, lastCommit: null });
  });
});
