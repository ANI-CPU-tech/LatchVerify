import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/build-installers.yml", root), "utf8");
/** The text of one job, from its key to the next job's. */
const job = (name: string): string => workflow.split(/^ {2}(?=[\w-]+:\n)/m).find((part) => part.startsWith(`${name}:\n`)) ?? "";

describe("the build-installers workflow", () => {
  it("is indented with spaces, as YAML requires", () => {
    expect(workflow).not.toMatch(/\t/);
  });

  it("runs on demand and on version tags, with the four jobs", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {2}push:\n {4}tags: \["v\*"\]$/m);
    for (const name of ["windows", "linux", "checksums", "release"]) expect(job(name), name).not.toBe("");
  });

  it("runs pnpm exec silently, so captured output is only the command's", () => {
    // pnpm 11 checks the install before exec and reports that on stdout, into $(...) and > files.
    expect(workflow).toContain("pnpm -s exec tsx packaging/version.ts");
    expect(workflow).not.toMatch(/pnpm exec /);
  });

  it("only uses repository files that exist", () => {
    const used = new Set([...workflow.matchAll(/\b((?:packaging|tests)\/[\w./-]+\.(?:ts|mjs|sh|ps1|iss)|packaging[\\/]windows[\\/]latchverify\.iss)\b/g)].map((match) => match[1]!.replace(/\\/g, "/")));
    expect(used.size).toBeGreaterThan(5);
    for (const file of used) expect(existsSync(new URL(file, root)), file).toBe(true);
  });

  it("asks version.ts and check-link.ts only for what they support", () => {
    for (const [, format] of workflow.matchAll(/version\.ts (\w+)/g)) expect(["semver", "deb", "arch", "windows"]).toContain(format);
    for (const [, mode] of workflow.matchAll(/\$check (\w+)/g)) expect(["client", "linked", "pinned", "unlinked", "probe"]).toContain(mode);
  });

  it("installs, checks and uninstalls every installer it builds", () => {
    for (const name of ["windows", "linux"]) {
      const text = job(name);
      for (const mode of ["client", "linked", "probe", "pinned", "unlinked"]) expect(text, `${name} ${mode}`).toContain(`$check ${mode}`);
    }
    expect(job("windows")).toContain("unins000.exe");
    expect(job("linux")).toContain("sudo apt-get remove -y latchverify");
    expect(job("linux")).toContain("uninstall.sh");
  });

  it("uploads the files the scripts build, under the names the release notes give", () => {
    expect(job("windows")).toContain("path: build/out/latchverify-*-windows-x64-setup.exe");
    for (const glob of ["build/out/*.deb", "build/out/*.tar.gz", "build/out/*.pkg.tar.zst"]) expect(job("linux")).toContain(glob);
    for (const text of [job("windows"), job("linux"), job("checksums")]) expect(text).toContain("if-no-files-found: error");
  });

  it("publishes only from a tag that matches package.json, with every package and SHA256SUMS", () => {
    const release = job("release");
    expect(release).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(release).toContain("needs: [windows, linux, checksums]");
    expect(release).toContain(`"v\${VERSION}"`);
    expect(release).toContain("packaging/release-notes.ts");
    for (const file of ["*.exe", "*.deb", "*.tar.gz", "*.pkg.tar.zst", "SHA256SUMS"]) expect(release).toContain(`packages/${file}`);
    expect(release).toContain("fail_on_unmatched_files: true");
  });

  it("signs and uploads latest.json for full releases only, failing without the update key", () => {
    const release = job("release");
    expect(release).toContain("LATCH_UPDATE_SIGNING_KEY: ${{ secrets.LATCH_UPDATE_SIGNING_KEY }}");
    expect(release).toContain("packaging/make-latest-json.ts");
    expect(release).toMatch(/latest\.json/);
    expect(release.indexOf("make-latest-json.ts")).toBeGreaterThan(release.indexOf("packaging/release-notes.ts"));
  });

  it("signs the Windows installer only when the certificate secret is set", () => {
    const windows = job("windows");
    expect(windows).toContain("WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}");
    expect(windows).toContain('"/DSignTool=1"');
    expect(windows).toContain("::warning::No code-signing certificate configured");
  });
});
