/**
 * Release version strings for each package format, from package.json's semver version
 * (x.y.z or x.y.z-prerelease). Each format orders a prerelease before its release.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface Version {
  /** x.y.z */
  core: string;
  /** The prerelease part without its leading "-", if any. */
  pre?: string;
}

/** @throws Error when `version` is not x.y.z or x.y.z-prerelease. */
export function parseVersion(version: string): Version {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`not a release version: ${JSON.stringify(version)} (expected x.y.z or x.y.z-prerelease)`);
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  return match[4] === undefined ? { core } : { core, pre: match[4] };
}

/** Debian upstream version: "~" sorts before the empty string, so 1.2.3~rc.1 < 1.2.3. */
export function debVersion(version: string): string {
  const { core, pre } = parseVersion(version);
  return pre === undefined ? core : `${core}~${pre.replaceAll("-", ".")}`;
}

/** Arch pkgver (letters, digits and periods only): letters after the release sort before it, so 1.2.3rc1 < 1.2.3. */
export function archVersion(version: string): string {
  const { core, pre } = parseVersion(version);
  return pre === undefined ? core : `${core}${pre.replace(/[^0-9A-Za-z]/g, "")}`;
}

/** Windows file version: four numbers, the prerelease dropped (VersionInfoVersion allows nothing else). */
export function windowsVersion(version: string): string {
  return `${parseVersion(version).core}.0`;
}

const FORMATS = { semver: (v: string) => (parseVersion(v), v), deb: debVersion, arch: archVersion, windows: windowsVersion } as const;

/**
 * Command line, for the build scripts: `tsx packaging/version.ts <format> [version]` prints
 * package.json's version (or the one given) in that format: semver, deb, arch or windows.
 */
if (process.argv[1]?.endsWith("version.ts")) {
  const [format, given] = process.argv.slice(2);
  if (format === undefined || !Object.hasOwn(FORMATS, format)) {
    console.error(`usage: version.ts ${Object.keys(FORMATS).join("|")} [version]`);
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const version = given ?? (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  try {
    console.log(FORMATS[format as keyof typeof FORMATS](version));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
