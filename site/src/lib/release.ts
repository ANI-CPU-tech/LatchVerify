/**
 * Which file to download for each system, from a GitHub release. The site bakes the latest release
 * into the HTML at build time (site/vite.config.ts) and refreshes it in the browser from the GitHub
 * API (src/ui/downloads.ts), so the buttons point at real files without a rebuild per release.
 *
 * Pure functions, tested in tests/site/release.test.ts against the names the release workflow
 * publishes (packaging/release-notes.ts and .github/workflows/build-installers.yml).
 */

const REPO = "ANI-CPU-tech/LatchVerify";
const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `${RELEASES_URL}/download/`;

export const PACKAGE_KINDS = ["windows", "deb", "arch", "tarball"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

/** How each release file is named; the capture is the version in that package's own format. */
export const FILE_PATTERNS: Readonly<Record<PackageKind, RegExp>> = {
  windows: /^latchverify-(.+)-windows-x64-setup\.exe$/,
  deb: /^latchverify_(.+)_amd64\.deb$/,
  arch: /^latchverify-bin-(.+)-1-x86_64\.pkg\.tar\.zst$/,
  tarball: /^latchverify-(.+)-linux-x64\.tar\.gz$/,
};

export interface ReleaseFile {
  name: string;
  url: string;
  /** Bytes; unknown in the build-time fallback. */
  size?: number;
  /** Lowercase hex; unknown in the build-time fallback. */
  sha256?: string;
}

export interface Release {
  /** Without the leading "v". */
  version: string;
  /** The release page. */
  url: string;
  /** ISO date; unknown in the build-time fallback. */
  publishedAt?: string;
  files: Partial<Record<PackageKind, ReleaseFile>>;
  /** The SHA256SUMS file, when the release has one. */
  sums?: string;
  /** Where the data came from: the GitHub API, or file names derived from a version. */
  source: "github" | "derived";
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^sha256:([0-9a-f]{64})$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A download link of this repository's releases, and nothing else: the page renders it as a link. */
function isReleaseDownload(url: unknown, tag: string, name: string): url is string {
  return typeof url === "string" && url === `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/**
 * A release from the GitHub API's JSON (GET /repos/{repo}/releases/latest), or null when it is not
 * a published, non-pre-release release of this repository. Assets that are not one of the four
 * packages are ignored; so is any field that does not have the expected shape.
 */
export function parseRelease(json: unknown): Release | null {
  if (!isRecord(json) || json.draft === true || json.prerelease === true) return null;
  const tag = json.tag_name;
  if (typeof tag !== "string" || !tag.startsWith("v") || !VERSION.test(tag.slice(1))) return null;
  const url = json.html_url;
  if (typeof url !== "string" || url !== `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`) return null;

  const release: Release = { version: tag.slice(1), url, files: {}, source: "github" };
  if (typeof json.published_at === "string" && !Number.isNaN(Date.parse(json.published_at))) release.publishedAt = json.published_at;

  for (const asset of Array.isArray(json.assets) ? json.assets : []) {
    if (!isRecord(asset) || typeof asset.name !== "string") continue;
    const name = asset.name;
    if (!isReleaseDownload(asset.browser_download_url, tag, name)) continue;
    if (name === "SHA256SUMS") {
      release.sums = asset.browser_download_url;
      continue;
    }
    const kind = PACKAGE_KINDS.find((k) => FILE_PATTERNS[k].test(name));
    if (!kind || release.files[kind]) continue;
    const file: ReleaseFile = { name, url: asset.browser_download_url };
    if (typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size > 0) file.size = asset.size;
    const digest = typeof asset.digest === "string" ? SHA256.exec(asset.digest) : null;
    if (digest) file.sha256 = digest[1];
    release.files[kind] = file;
  }
  return release;
}

/**
 * The files a release of `version` publishes, for when the API cannot be asked. `formats` are the
 * version as the deb and Arch packages spell it (packaging/version.ts debVersion and archVersion).
 * GitHub turns "~" in an asset name into ".", so a pre-release deb is named with a dot.
 */
export function derivedRelease(version: string, formats: { deb: string; arch: string }): Release {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  const tag = `v${version}`;
  const names: Record<PackageKind, string> = {
    windows: `latchverify-${version}-windows-x64-setup.exe`,
    deb: `latchverify_${formats.deb.replaceAll("~", ".")}_amd64.deb`,
    arch: `latchverify-bin-${formats.arch}-1-x86_64.pkg.tar.zst`,
    tarball: `latchverify-${version}-linux-x64.tar.gz`,
  };
  const link = (name: string) => `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  const files: Partial<Record<PackageKind, ReleaseFile>> = {};
  for (const kind of PACKAGE_KINDS) files[kind] = { name: names[kind], url: link(names[kind]) };
  return { version, url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`, files, sums: link("SHA256SUMS"), source: "derived" };
}

/** Compares x.y.z[-pre] versions: a release ranks above its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split(/-(.*)/s, 2) as [string, string | undefined];
    return { nums: core.split(".").map(Number), pre };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/** The command that installs a downloaded file, run in the folder it was saved to; null for the Windows setup, which is run directly. */
export function installCommand(kind: PackageKind, name: string): string | null {
  switch (kind) {
    case "windows":
      return null;
    case "deb":
      return `sudo apt install ./${name}`;
    case "arch":
      return `sudo pacman -U ${name}`;
    case "tarball":
      return `tar -xzf ${name} && ./${name.replace(/\.tar\.gz$/, "")}/install.sh`;
  }
}

/**
 * What the page shows for a release, by field name: "release.version", "file.deb.url", ... The
 * build fills {{field}} placeholders with it (site/plugin/template.ts) and the browser refreshes
 * the elements marked with the same names (src/ui/downloads.ts). Unknown data is an empty string;
 * a link to a file that is missing falls back to the release page.
 */
export function releaseFields(release: Release): Map<string, string> {
  const fields = new Map<string, string>([
    ["release.version", release.version],
    ["release.url", release.url],
    ["release.date", release.publishedAt ? formatDate(release.publishedAt) : ""],
    ["release.sums", release.sums ?? release.url],
  ]);
  for (const kind of PACKAGE_KINDS) {
    const file = release.files[kind];
    fields.set(`file.${kind}.name`, file?.name ?? "");
    fields.set(`file.${kind}.url`, file?.url ?? release.url);
    fields.set(`file.${kind}.size`, file?.size ? formatBytes(file.size) : "");
    fields.set(`file.${kind}.sha`, file?.sha256 ?? "");
    fields.set(`file.${kind}.cmd`, file ? (installCommand(kind, file.name) ?? "") : "");
  }
  return fields;
}

/** File size as GitHub shows it: binary units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A release date for people, in English, fixed to UTC so the server-built page and the browser agree. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
