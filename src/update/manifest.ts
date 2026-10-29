import { z } from "zod";

/** Install kinds a release ships an update for; each installer writes its kind in INSTALL_KIND_FILE. */
export const INSTALL_KINDS = ["inno", "deb", "pacman", "tarball"] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

/** The latest.json platform key of each install kind (x86_64 only, as the installers are). */
export const PLATFORM_KEYS: Record<InstallKind, string> = {
  inno: "windows-x86_64-inno",
  deb: "linux-x86_64-deb",
  pacman: "linux-x86_64-pacman",
  tarball: "linux-x86_64-tarball",
};

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** latest.json, published with every release (packaging/make-latest-json.ts). */
export const ManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  notes: z.string().max(20_000),
  pub_date: z.iso.datetime(),
  platforms: z.record(
    z.string(),
    z.object({
      url: z.url({ protocol: /^https$/ }),
      sha256: Sha256,
      /** base64 ed25519 signature of signedMessage(version, key, sha256). */
      signature: z.string().min(1).max(200),
    }),
  ),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** What a release signs for one file: the version, the platform and the file's sha256, so no signature fits another file or release. */
export function signedMessage(version: string, platformKey: string, sha256: string): string {
  return `latchverify-update\n${version}\n${platformKey}\n${sha256}\n`;
}

/** x.y.z as numbers; undefined for anything else (pre-releases are never offered). */
export function parseRelease(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `candidate` is a newer release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseRelease(candidate);
  const b = parseRelease(current.replace(/[-+].*$/, ""));
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
