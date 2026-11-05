import { describe, expect, it } from "vitest";
import { changelogSection, releaseNotes } from "../../packaging/release-notes.js";

const changelog = `# Changelog

## 1.2.0 — 2026-11-01

### Added
- Thing one.

## 1.1.0

- Older thing.
`;

describe("changelogSection", () => {
  it("takes the version's section, with or without a date or a v", () => {
    expect(changelogSection(changelog, "1.2.0")).toBe("### Added\n- Thing one.");
    expect(changelogSection(changelog, "1.1.0")).toBe("- Older thing.");
    expect(changelogSection("## v2.0.0\nNew.", "2.0.0")).toBe("New.");
  });

  it("does not match a longer version or a missing one", () => {
    expect(changelogSection("## 1.2.0-rc.1\nPre.", "1.2.0")).toBeNull();
    expect(changelogSection(changelog, "9.9.9")).toBeNull();
    expect(changelogSection("## 1.0.0\n\n## 0.9.0\nx", "1.0.0")).toBeNull();
  });
});

describe("releaseNotes", () => {
  it("adds the downloads table to the changelog section", () => {
    const { notes, fromChangelog } = releaseNotes(changelog, "1.2.0");
    expect(fromChangelog).toBe(true);
    expect(notes).toMatch(/^### Added\n- Thing one\.\n\n## Downloads/);
    expect(notes).toContain("latchverify-1.2.0-windows-x64-setup.exe");
    expect(notes).toContain("SHA256SUMS");
  });

  it("names each package's exact file, never a glob that also matches an older download", () => {
    const { notes } = releaseNotes(changelog, "0.2.0-rc.2");
    expect(notes).toContain("`sudo pacman -U latchverify-bin-0.2.0rc2-1-x86_64.pkg.tar.zst`");
    expect(notes).toContain("`sudo apt install ./latchverify_0.2.0.rc.2_amd64.deb`");
    expect(notes).toContain("./latchverify-0.2.0-rc.2-linux-x64/install.sh");
    expect(notes).not.toContain("*");
  });

  it("falls back to plain notes, and rejects a version that is not one", () => {
    expect(releaseNotes(changelog, "3.0.0")).toMatchObject({ fromChangelog: false });
    expect(releaseNotes(changelog, "3.0.0").notes).toMatch(/^LatchVerify 3\.0\.0\./);
    expect(() => releaseNotes(changelog, "latest")).toThrow(/not a release version/);
  });
});
