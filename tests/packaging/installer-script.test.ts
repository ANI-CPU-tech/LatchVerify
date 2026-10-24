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

  it("links Claude Code after installing and unlinks before the files are removed", () => {
    expect(iss).toMatch(/CurStep = ssPostInstall\) and WizardIsTaskSelected\('linkclaude'\)/);
    expect(iss).toMatch(/RunLatch\('setup', LogFile\)/);
    expect(iss).toMatch(/CurUninstallStep = usUninstall[\s\S]*RunLatch\('setup --remove'/);
  });
});
