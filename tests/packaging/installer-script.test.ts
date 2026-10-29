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

  it("ships the desktop app, starts it from the Start menu and after installing, and removes its login start", () => {
    expect(section("Files")).toContain('Source: "{#StageDir}\\desktop\\*"; DestDir: "{app}\\desktop"');
    expect(section("Icons")).toContain('Filename: "{app}\\desktop\\latchverify-desktop.exe"');
    expect(iss).not.toContain("review --ui");
    expect(section("Run")).toContain("Flags: nowait postinstall skipifsilent");
    expect(section("Run")).toContain("Check: RelaunchRequested");
    expect(iss).toContain("ExpandConstant('{param:relaunch|0}') = '1'");
    expect(section("Registry")).toContain('ValueName: "io.github.vinayakkam.LatchVerify"; Flags: uninsdeletevalue');
    expect(iss).toMatch(/usUninstall[\s\S]*taskkill\.exe'\), '\/F \/IM latchverify-desktop\.exe'[\s\S]*RunLatch\('setup --remove --all'/);
  });

  it("keeps CRLF line endings, as Inno Setup scripts on Windows have", () => {
    expect(iss.split("\n").length - 1).toBe(iss.split("\r\n").length - 1);
  });
});

describe("the Linux install hooks", () => {
  const read = (path: string) => readFileSync(new URL(`packaging/${path}`, root), "utf8");

  it("connect nothing without the user's say-so, and unlink every client on removal, as the installing user", () => {
    const linkUser = read("linux/link-user");
    expect(linkUser).toContain('setup) args="setup" ;;');
    expect(linkUser).toContain('remove) args="setup --remove --all" ;;');
    expect(read("debian/postinst")).toContain("/usr/lib/latchverify/link-user setup");
    expect(read("debian/prerm")).toContain("/usr/lib/latchverify/link-user remove");
    expect(read("arch/latchverify.install")).toMatch(/post_install\(\) \{\n {2}\/usr\/lib\/latchverify\/link-user setup/);
    expect(read("arch/latchverify.install")).toMatch(/pre_remove\(\) \{\n {2}\/usr\/lib\/latchverify\/link-user remove/);
  });

  it("ask in the terminal from the tarball's install.sh, and unlink every client in uninstall.sh", () => {
    expect(read("linux/install.sh")).toContain('"$lib/latch" setup ||');
    expect(read("linux/uninstall.sh")).toContain('"$lib/latch" setup --remove --all ||');
  });

  it("ship and launch the desktop app, never the old terminal launcher", () => {
    expect(existsSync(new URL("packaging/linux/latchverify-review", root))).toBe(false);
    const entry = read("linux/io.github.vinayakkam.LatchVerify.desktop");
    expect(entry).toContain("Exec=latchverify-desktop");
    expect(entry).toContain("Terminal=false");
    for (const script of ["linux/build-deb.sh", "linux/build-tarball.sh", "linux/install.sh"]) {
      expect(read(script), script).toContain("desktop");
      expect(read(script), script).not.toMatch(/\$(?:repo\/packaging\/linux|src)\/latchverify-review/);
    }
    expect(read("linux/build-deb.sh")).toContain('chmod 4755 "$lib/desktop/chrome-sandbox"');
    // Installed as root: every user must be able to read the app, whatever modes the build left.
    expect(read("linux/build-deb.sh")).toContain('chmod -R go+rX,go-w "$root"');
    expect(read("linux/build-tarball.sh")).toContain('chmod -R go+rX,go-w "$dir"');
    expect(read("../packaging/build-desktop.ts")).toContain("chmodSync(desktop, 0o755)");
    expect(read("linux/install.sh")).toContain('"$src/install-kind"');
  });

  it("stop the app and remove its login start before unlinking", () => {
    for (const [script, unlink] of [["linux/link-user", '"$here/latch" $args'], ["linux/uninstall.sh", '"$lib/latch" setup --remove --all']] as const) {
      const text = read(script);
      expect(text.indexOf("pkill"), script).toBeGreaterThan(-1);
      expect(text.indexOf("pkill"), script).toBeLessThan(text.indexOf(unlink));
      expect(text, script).toContain("autostart/latchverify.desktop");
    }
  });
});
