import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const iss = readFileSync(new URL("packaging/windows/latchverify.iss", root), "utf8");
const section = (name: string): string => iss.split(/^\[/m).find((part) => part.startsWith(`${name}]`)) ?? "";

describe("the Inno Setup script", () => {
  it("ships files that exist next to it, and the repository's LICENSE", () => {
    for (const [, source] of section("Files").matchAll(/^Source: "([^"{]+)"/gm)) {
      expect(existsSync(new URL(`packaging/windows/${source}`, root)), source).toBe(true);
    }
    expect(iss).toContain("LicenseFile={#RepoDir}\\LICENSE");
    expect(existsSync(new URL("packaging/windows/latchverify.ico", root))).toBe(true);
    expect(existsSync(new URL("LICENSE", root))).toBe(true);
  });

  it("declares every task its code and entries refer to", () => {
    const declared = [...section("Tasks").matchAll(/^Name: (\w+);/gm)].map((match) => match[1]);
    const used = [...iss.matchAll(/WizardIsTaskSelected\('(\w+)'\)|Tasks: (\w+)/g)].map((match) => match[1] ?? match[2]);
    expect(used.length).toBeGreaterThan(0);
    for (const task of used) expect(declared, task).toContain(task);
  });

  it("requires the defines the workflow passes and names its output after the version", () => {
    for (const define of ["AppVersion", "FileVersion", "StageDir"]) expect(iss).toContain(`#ifndef ${define}`);
    expect(iss).toContain("OutputBaseFilename=latchverify-{#AppVersion}-windows-x64-setup");
  });

  it("links every MCP client after installing and unlinks them all before the files are removed", () => {
    expect(iss).toMatch(/CurStep = ssPostInstall\) and WizardIsTaskSelected\('linkclients'\)/);
    expect(iss).toMatch(/RunLatch\('setup --all', LogFile\)/);
    expect(iss).toMatch(/CurUninstallStep = usUninstall[\s\S]*RunLatch\('setup --remove --all'/);
  });
});

describe("the Linux install hooks", () => {
  const read = (path: string) => readFileSync(new URL(`packaging/${path}`, root), "utf8");

  it("link and unlink every MCP client, as the installing user", () => {
    const linkUser = read("linux/link-user");
    expect(linkUser).toContain('setup) args="setup --all" ;;');
    expect(linkUser).toContain('remove) args="setup --remove --all" ;;');
    expect(read("debian/postinst")).toContain("/usr/lib/latchverify/link-user setup");
    expect(read("debian/prerm")).toContain("/usr/lib/latchverify/link-user remove");
    expect(read("arch/latchverify.install")).toMatch(/post_install\(\) \{\n {2}\/usr\/lib\/latchverify\/link-user setup/);
    expect(read("arch/latchverify.install")).toMatch(/pre_remove\(\) \{\n {2}\/usr\/lib\/latchverify\/link-user remove/);
  });

  it("link every client from the tarball's install.sh and unlink them in uninstall.sh", () => {
    expect(read("linux/install.sh")).toContain('"$lib/latch" setup --all ||');
    expect(read("linux/uninstall.sh")).toContain('"$lib/latch" setup --remove --all ||');
  });
});
