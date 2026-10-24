import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
const empty = { version: "1", generatedAt: "1970-01-01T00:00:00.000Z", servers: {} };

/** `latch verify` from `cwd`, with the per-user config directory at `xdg`. Returns output and exit code. */
function verify(cwd: string, xdg: string): { output: string; code: number } {
  try {
    const output = execFileSync(process.execPath, ["--import", tsx, cli, "verify"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: xdg, LATCH_LOCKFILE_PATH: "", LATCH_STATE_DIR: "", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; status: number };
    return { output: failed.stdout + failed.stderr, code: failed.status };
  }
}

describe.skipIf(process.platform === "win32")("the per-user lockfile from latch setup", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "latch-user-lock-"));
    await mkdir(join(dir, "xdg", "latchverify"), { recursive: true });
    await mkdir(join(dir, "anywhere"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is what latch verify reads outside a project, instead of asking for ./latch.lock", async () => {
    const user = join(dir, "xdg", "latchverify", "latch.lock");
    await writeFile(user, JSON.stringify(empty));
    const { output, code } = verify(join(dir, "anywhere"), join(dir, "xdg"));
    expect(output).toContain(user);
    expect(output).not.toContain("no lockfile");
    expect(code).toBe(0);
  });

  it("loses to a project's own latch.lock", async () => {
    await writeFile(join(dir, "xdg", "latchverify", "latch.lock"), JSON.stringify(empty));
    await writeFile(join(dir, "anywhere", "latch.lock"), JSON.stringify(empty));
    expect(verify(join(dir, "anywhere"), join(dir, "xdg")).output).toContain(join(dir, "anywhere", "latch.lock"));
  });

  it("is where latch setup links and creates the lockfile, wherever the installer runs it", async () => {
    const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg"), LATCH_LOCKFILE_PATH: "", LATCH_STATE_DIR: "", NO_COLOR: "1" };
    const output = execFileSync(process.execPath, ["--import", tsx, cli, "setup"], { cwd: join(dir, "anywhere"), encoding: "utf8", env });
    const user = join(dir, "xdg", "latchverify", "latch.lock");
    expect(output).toContain(`linking Claude Code to ${user}`);
    expect(output).toContain(`created ${user}`);
    await expect(readFile(join(dir, "anywhere", "latch.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(user, "utf8"))).toMatchObject({ servers: {} });
  });
});
