import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFile } from "../../src/store/replace.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

/** A rename that fails with `codes`, one per call, then succeeds. */
function flaky(...codes: string[]) {
  const calls: string[] = [];
  const renameFile = async (from: string, to: string) => {
    calls.push(`${from}->${to}`);
    const code = codes.shift();
    if (code) throw errno(code);
  };
  return { calls, renameFile };
}

describe("replaceFile", () => {
  it("renames over an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-replace-"));
    try {
      await writeFile(join(dir, "new"), "new");
      await writeFile(join(dir, "target"), "old");
      await replaceFile(join(dir, "new"), join(dir, "target"));
      expect(await readFile(join(dir, "target"), "utf8")).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries on Windows while the target is busy", async () => {
    const { calls, renameFile } = flaky("EPERM", "EACCES", "EBUSY");
    await replaceFile("a", "b", { platform: "win32", renameFile });
    expect(calls).toEqual(["a->b", "a->b", "a->b", "a->b"]);
  });

  it("does not retry on Windows when the target is a directory, which never stops being busy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-replace-"));
    try {
      const { calls, renameFile } = flaky("EPERM", "EPERM");
      await expect(replaceFile("a", dir, { platform: "win32", renameFile })).rejects.toThrow("EPERM");
      expect(calls).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not retry elsewhere, or for other errors", async () => {
    const posix = flaky("EPERM");
    await expect(replaceFile("a", "b", { platform: "linux", renameFile: posix.renameFile })).rejects.toMatchObject({ code: "EPERM" });
    expect(posix.calls).toHaveLength(1);

    const missing = flaky("ENOENT");
    await expect(replaceFile("a", "b", { platform: "win32", renameFile: missing.renameFile })).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.calls).toHaveLength(1);
  });

  it("gives up on Windows once the timeout passes", async () => {
    const renameFile = async () => {
      throw errno("EPERM");
    };
    const started = Date.now();
    await expect(replaceFile("a", "b", { platform: "win32", timeoutMs: 50, renameFile })).rejects.toMatchObject({ code: "EPERM" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
