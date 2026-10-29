/**
 * Writes latest.json, the update manifest the apps check (src/update): the version, its
 * CHANGELOG section as notes, and for each installer its download URL, sha256 and an ed25519
 * signature of signedMessage(version, platform, sha256) made with LATCH_UPDATE_SIGNING_KEY.
 *
 * Usage: LATCH_UPDATE_SIGNING_KEY=<pem> tsx packaging/make-latest-json.ts <version> <packages dir> > latest.json
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLATFORM_KEYS, signedMessage, type InstallKind, type Manifest } from "../src/update/manifest.js";
import { changelogSection } from "./release-notes.js";
import { parseVersion } from "./version.js";

export const RELEASES = "https://github.com/ANI-CPU-tech/LatchVerify/releases/download";

/** The installer file of each kind among `files`; exactly one each. */
export function installersByKind(files: readonly string[]): Record<InstallKind, string> {
  const pick = (kind: InstallKind, test: (name: string) => boolean): [InstallKind, string] => {
    const found = files.filter(test);
    if (found.length !== 1) throw new Error(`expected one ${kind} installer, found ${found.length}: ${found.join(", ") || "none"}`);
    return [kind, found[0]!];
  };
  return Object.fromEntries([
    pick("inno", (name) => name.endsWith("-windows-x64-setup.exe")),
    pick("deb", (name) => name.endsWith("_amd64.deb")),
    pick("pacman", (name) => name.endsWith(".pkg.tar.zst")),
    pick("tarball", (name) => name.endsWith("-linux-x64.tar.gz")),
  ]) as Record<InstallKind, string>;
}

export function makeManifest(version: string, dir: string, privateKeyPem: string, changelog: string, now: Date): Manifest {
  parseVersion(version);
  if (version.includes("-")) throw new Error(`${version} is a pre-release; updates are offered for releases only`);
  const key = createPrivateKey(privateKeyPem);
  const platforms: Manifest["platforms"] = {};
  for (const [kind, name] of Object.entries(installersByKind(readdirSync(dir))) as Array<[InstallKind, string]>) {
    const sha256 = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    const platform = PLATFORM_KEYS[kind];
    platforms[platform] = {
      url: `${RELEASES}/v${version}/${encodeURIComponent(name)}`,
      sha256,
      signature: sign(null, Buffer.from(signedMessage(version, platform, sha256), "utf8"), key).toString("base64"),
    };
  }
  return { version, notes: changelogSection(changelog, version) ?? `LatchVerify ${version}.`, pub_date: now.toISOString(), platforms };
}

if (process.argv[1]?.endsWith("make-latest-json.ts")) {
  const [version, dir] = process.argv.slice(2);
  const pem = process.env.LATCH_UPDATE_SIGNING_KEY;
  if (!version || !dir || !pem) {
    console.error("usage: LATCH_UPDATE_SIGNING_KEY=<pem> make-latest-json.ts <version> <packages dir>");
    process.exit(2);
  }
  const changelog = readFileSync(resolve(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
  process.stdout.write(`${JSON.stringify(makeManifest(version, resolve(dir), pem, changelog, new Date()), null, 2)}\n`);
}
