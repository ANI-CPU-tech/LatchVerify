/**
 * The GitHub release body for a version: its section of CHANGELOG.md ("## <version>", with or
 * without a date after it), then which file to download for each system and how to check it.
 *
 * Usage: tsx packaging/release-notes.ts <version> > notes.md
 * Without a section for the version it warns on stderr and writes plain notes instead.
 */
import { readFileSync } from "node:fs";
import { archVersion, debVersion, parseVersion } from "./version.js";

/** The body of the "## <version>" section, without its heading; null when there is none. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+v?${escaped}(\\s|$)`).test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * Which file to download for each system, and how to check it against SHA256SUMS. Each command
 * names its exact file: a glob such as latchverify-bin-*.pkg.tar.zst also matches an older download
 * in the same folder, and pacman then stops with "duplicate target".
 */
export function downloads(version: string): string {
  // GitHub turns the "~" of a pre-release's Debian version into "." in the asset's name.
  const deb = `latchverify_${debVersion(version).replaceAll("~", ".")}_amd64.deb`;
  const arch = `latchverify-bin-${archVersion(version)}-1-x86_64.pkg.tar.zst`;
  const tarball = `latchverify-${version}-linux-x64`;
  return [
    "## Downloads",
    "",
    "| System | File | Install |",
    "|---|---|---|",
    `| Windows 10/11 (x64) | \`latchverify-${version}-windows-x64-setup.exe\` | Run it. No administrator rights needed. |`,
    `| Debian / Ubuntu (x64) | \`${deb}\` | \`sudo apt install ./${deb}\` |`,
    `| Arch / CachyOS (x64) | \`${arch}\` | \`sudo pacman -U ${arch}\` |`,
    `| Other Linux (x64) | \`${tarball}.tar.gz\` | \`tar -xzf ${tarball}.tar.gz && ./${tarball}/install.sh\` |`,
    "",
    "Installing a newer version replaces the one installed; there is no need to uninstall first.",
    "",
    "After installing, choose which MCP clients to connect (the Windows installer asks; on Linux run `latch setup`). An installed LatchVerify updates itself from signed releases. See [INSTALL.md](https://github.com/ANI-CPU-tech/LatchVerify/blob/main/INSTALL.md).",
    "",
    "Check a download against `SHA256SUMS`: `sha256sum -c SHA256SUMS --ignore-missing` (Linux) or `Get-FileHash <file>` (PowerShell).",
  ].join("\n");
}

export function releaseNotes(changelog: string, version: string): { notes: string; fromChangelog: boolean } {
  parseVersion(version);
  const section = changelogSection(changelog, version);
  const intro = section ?? `LatchVerify ${version}.`;
  return { notes: `${intro}\n\n${downloads(version)}\n`, fromChangelog: section !== null };
}

if (process.argv[1]?.endsWith("release-notes.ts")) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: release-notes.ts <version>");
    process.exit(2);
  }
  const { notes, fromChangelog } = releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version);
  if (!fromChangelog) console.error(`::warning::CHANGELOG.md has no "## ${version}" section; the release gets plain notes.`);
  process.stdout.write(notes);
}
