import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ID } from "../../scripts/package/config.js";
import { assertCleanTree, stageLinuxTree, stageWindowsTree, type StageContext } from "../../scripts/package/stage.js";
import { TARGETS, type BuildContext } from "../../scripts/package/targets.js";

let dir: string;
let ctx: BuildContext;

/** A minimal staged app: what stageApp() produces, without running the real build. */
async function fakeApp(): Promise<string> {
  const app = join(dir, "app");
  await mkdir(join(app, "dist", "web"), { recursive: true });
  await writeFile(join(app, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('0.1.0')\n");
  await writeFile(join(app, "dist", "web", "index.html"), "<!doctype html>");
  await writeFile(join(app, "package.json"), "{}");
  await writeFile(join(app, "LICENSE"), "MIT");
  return app;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-stage-"));
  const base: StageContext = { version: "0.1.0", workDir: join(dir, "work"), log: () => undefined, pnpm: ["pnpm"], date: "2026-10-23" };
  ctx = { ...base, outDir: join(dir, "out"), sourceDateEpoch: 0 };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertCleanTree", () => {
  it("counts files in a clean tree", async () => {
    expect(await assertCleanTree(await fakeApp())).toBe(4);
  });

  it.each([".env", ".env.local", ".npmrc", "id_ed25519", "server.pem", "latch.lock", ".git-credentials"])("refuses a tree with %s", async (name) => {
    const app = await fakeApp();
    await writeFile(join(app, "dist", name), "secret");
    await expect(assertCleanTree(app)).rejects.toThrow("looks like a secret or local state");
  });

  it("refuses symlinks where the archive cannot hold them", async () => {
    const app = await fakeApp();
    await symlink("cli.js", join(app, "dist", "link.js"));
    await expect(assertCleanTree(app)).resolves.toBeGreaterThan(0);
    await expect(assertCleanTree(app, { noSymlinks: true })).rejects.toThrow("symlink");
  });
});

describe("stageLinuxTree", () => {
  it("lays out bin, lib and share with a relative latch symlink, launcher, icons and metadata", async () => {
    const prefix = join(dir, "usr");
    await stageLinuxTree(ctx, await fakeApp(), prefix);
    expect(await readlink(join(prefix, "bin", "latch"))).toBe("../lib/latchverify/dist/cli.js");
    expect((await lstat(join(prefix, "bin", "latchverify-review"))).mode & 0o111).not.toBe(0);
    expect(existsSync(join(prefix, "lib", "latchverify", "dist", "web", "index.html"))).toBe(true);
    for (const size of ["16x16", "256x256", "512x512"]) expect(existsSync(join(prefix, "share", "icons", "hicolor", size, "apps", `${APP_ID}.png`))).toBe(true);
    expect(existsSync(join(prefix, "share", "icons", "hicolor", "scalable", "apps", `${APP_ID}.svg`))).toBe(true);
    const desktop = await readFile(join(prefix, "share", "applications", `${APP_ID}.desktop`), "utf8");
    expect(desktop).toContain(`Icon=${APP_ID}`);
    expect(desktop).toContain("Exec=latchverify-review");
    const metainfo = await readFile(join(prefix, "share", "metainfo", `${APP_ID}.metainfo.xml`), "utf8");
    expect(metainfo).toContain('<release version="0.1.0" date="2026-10-23"/>');
    expect(metainfo).not.toMatch(/@[A-Z_]+@/);
  });
});

describe("stageWindowsTree", () => {
  it("writes CRLF launchers, an icon and the app, with no symlinks", async () => {
    const root = await stageWindowsTree(ctx, await fakeApp(), join(dir, "win"));
    for (const name of ["latch.cmd", "LatchVerify Review.cmd", "README.txt"]) {
      const text = await readFile(join(root, name), "utf8");
      expect(text, name).not.toMatch(/[^\r]\n/);
    }
    expect(await readFile(join(root, "latch.cmd"), "utf8")).toContain('node "%~dp0app\\dist\\cli.js" %*');
    expect((await readFile(join(root, "latchverify.ico"))).readUInt16LE(2)).toBe(1);
    expect(existsSync(join(root, "app", "dist", "cli.js"))).toBe(true);
  });
});

describe("target configuration", () => {
  it.each(Object.keys(TARGETS))("%s: packaging files render and pass the installed validators", async (id) => {
    const checks = await TARGETS[id as keyof typeof TARGETS].validate(ctx);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("every target documents install and uninstall for its version", () => {
    for (const target of Object.values(TARGETS)) {
      const text = target.install("1.2.3-rc.1");
      expect(text, target.id).toMatch(/## Install/);
      expect(text, target.id).toMatch(/## Uninstall/);
      expect(text, target.id).not.toMatch(/@[A-Z_]+@/);
    }
  });

  it("an Arch build refuses a shared portable archive for another version", async () => {
    const wrong = join(dir, "latchverify-9.9.9-linux-portable.tar.gz");
    await writeFile(wrong, "x");
    process.env.LATCH_PORTABLE_TARBALL = wrong;
    try {
      await expect(TARGETS.arch.package(ctx, await fakeApp())).rejects.toThrow("LATCH_PORTABLE_TARBALL must be latchverify-0.1.0-linux-portable.tar.gz");
    } finally {
      delete process.env.LATCH_PORTABLE_TARBALL;
    }
  });

  it("the Linux launcher is valid POSIX sh", () => {
    expect(() => execFileSync("sh", ["-n", new URL("../../packaging/linux/latchverify-review", import.meta.url).pathname])).not.toThrow();
  });
});
