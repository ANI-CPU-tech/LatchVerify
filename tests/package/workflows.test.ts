import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir).filter((name) => name.endsWith(".yml"));
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");

/** Every `run:` script (inline or block) with the line it starts on. */
function runScripts(text: string): Array<{ line: number; script: string }> {
  const lines = text.split("\n");
  const scripts: Array<{ line: number; script: string }> = [];
  lines.forEach((line, i) => {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (!match) return;
    const indent = match[1]!.length;
    if (match[2] !== "|" && match[2] !== ">") {
      scripts.push({ line: i + 1, script: match[2]! });
      return;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push({ line: i + 1, script: body.join("\n") });
  });
  return scripts;
}

describe.each(workflows)("%s", (name) => {
  const text = read(name);

  it("never interpolates ${{ }} expressions into shell scripts (script injection)", () => {
    const scripts = runScripts(text);
    expect(scripts.length).toBeGreaterThan(0);
    for (const { line, script } of scripts) expect(script, `${name}:${line}`).not.toContain("${{");
  });

  it("starts read-only and uses tabs nowhere", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(text).not.toContain("\t");
  });
});

describe("release workflow", () => {
  const release = read("release.yml");

  it("runs only for version tags and requires a signed Windows installer by default", () => {
    expect(release).toMatch(/on:\n {2}push:\n {4}tags:\n {6}- "v\*\.\*\.\*"/);
    expect(release).toContain("require_signing: ${{ vars.LATCH_ALLOW_UNSIGNED_WINDOWS != 'true' }}");
  });

  it("attests every released file before publishing", () => {
    expect(release.indexOf("attest-build-provenance")).toBeGreaterThan(release.indexOf("pnpm package --release"));
    expect(release.indexOf("gh release create")).toBeGreaterThan(release.indexOf("attest-build-provenance"));
  });
});

describe("package workflow", () => {
  const pkg = read("package.yml");

  it("builds every target", () => {
    for (const target of ["linux-tarball", "deb", "windows-zip", "package arch", "package flatpak", "windows-installer"]) expect(pkg).toContain(target);
  });

  it("gives the arch and flatpak builds the published portable archive", () => {
    expect(pkg.match(/LATCH_PORTABLE_TARBALL=/g)).toHaveLength(2);
  });
});
