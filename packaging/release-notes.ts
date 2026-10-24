/**
 * The GitHub release body for a version: its section of CHANGELOG.md ("## <version>", with or
 * without a date after it), then which file to download for each system and how to check it.
 *
 * Usage: tsx packaging/release-notes.ts <version> > notes.md
 * Without a section for the version it warns on stderr and writes plain notes instead.
 */
import { readFileSync } from "node:fs";
import { parseVersion } from "./version.js";

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

/** Which file to download for each system, and how to check it against SHA256SUMS. */
export function downloads(version: string): string {
  return [
    "## Downloads",
    "",
    "| System | File | Install |",
    "|---|---|---|",
    `| Windows 10/11 (x64) | \`latchverify-${version}-windows-x64-setup.exe\` | Run it. No administrator rights needed. |`,
    `| Debian / Ubuntu (x64) | \`latchverify_<version>_amd64.deb\` | \`sudo apt install ./latchverify_*_amd64.deb\` |`,
    `| Arch / CachyOS (x64) | \`latchverify-bin-<version>-1-x86_64.pkg.tar.zst\` | \`sudo pacman -U latchverify-bin-*.pkg.tar.zst\` |`,
    `| Other Linux (x64) | \`latchverify-${version}-linux-x64.tar.gz\` | Unpack, then run \`./install.sh\` |`,
    "",
    "Installing links Claude Code for you: its MCP servers start behind latch and their tools are pinned in your own `latch.lock`. Restart Claude Code afterwards. See [INSTALL.md](https://github.com/vinayakkam/LatchVerify/blob/main/INSTALL.md).",
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
