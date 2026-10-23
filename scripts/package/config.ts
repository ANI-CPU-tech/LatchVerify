import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildVersionSchema } from "../../src/schema/index.js";

/** Fixed packaging settings. Nothing here comes from the UI. */

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const PACKAGING_DIR = join(REPO_ROOT, "packaging");
/** Every build writes under here: build/packages/<version>/<target>/. Gitignored. */
export const OUTPUT_ROOT = join(REPO_ROOT, "build", "packages");

/**
 * Reverse-DNS app id for the desktop entry, icons, AppStream and Flatpak. Flathub needs an id
 * under a domain or code-hosting account you control; see packaging/flatpak/FLATHUB.md.
 */
export const APP_ID = "io.github.vinayakkam.LatchVerify";
export const HOMEPAGE = "https://github.com/vinayakkam/Nexathon2026";
export const FLATPAK_RUNTIME_VERSION = "24.08";
export const FLATPAK_REFS = [
  `org.freedesktop.Platform//${FLATPAK_RUNTIME_VERSION}`,
  `org.freedesktop.Sdk//${FLATPAK_RUNTIME_VERSION}`,
  `org.freedesktop.Sdk.Extension.node22//${FLATPAK_RUNTIME_VERSION}`,
] as const;

const DEFAULT_PACKAGER = "LatchVerify contributors <latchverify@users.noreply.github.com>";
const PACKAGER_PATTERN = /^[^<>\r\n]{1,100} <[^<>\s@]+@[^<>\s@]+>$/;

/** Maintainer line for PKGBUILD and Debian control: LATCH_PACKAGER ("Name <email>"), else a neutral default. */
export function packager(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.LATCH_PACKAGER?.trim();
  if (!value) return DEFAULT_PACKAGER;
  if (!PACKAGER_PATTERN.test(value)) throw new Error(`LATCH_PACKAGER must look like "Name <email@example.com>", got ${JSON.stringify(value)}`);
  return value;
}

/** Throws unless `version` is MAJOR.MINOR.PATCH with an optional pre-release (BuildVersionSchema). */
export function assertVersion(version: string): void {
  if (!BuildVersionSchema.safeParse(version).success) throw new Error(`version must look like 1.2.3 or 1.2.3-rc.1, got ${JSON.stringify(version)}`);
}

/** Arch pkgver: no hyphen allowed; "1.2.3-rc.1" becomes "1.2.3rc.1", which vercmp orders before 1.2.3. */
export const archPkgver = (version: string): string => version.replace("-", "");

/** Debian version: "~" sorts a pre-release before the release; "-1" is the package revision. */
export const debianVersion = (version: string): string => `${version.replace("-", "~")}-1`;

/** Windows version resources take four numbers: 1.2.3-rc.1 becomes 1.2.3.0. */
export const numericVersion = (version: string): string => `${version.split("-")[0]}.0`;

/** The version in the repository's package.json, the default for new builds. */
export async function projectVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Renders a template's @NAME@ placeholders. Strict both ways: a placeholder without a value or
 * a value without a placeholder throws, so a typo cannot ship a literal "@VERSION@".
 */
export function render(template: string, vars: Record<string, string>): string {
  const used = new Set<string>();
  const out = template.replace(/@([A-Z][A-Z0-9_]*)@/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`template placeholder @${name}@ has no value`);
    used.add(name);
    return value;
  });
  const unused = Object.keys(vars).filter((name) => !used.has(name));
  if (unused.length > 0) throw new Error(`template has no placeholder for ${unused.map((n) => `@${n}@`).join(", ")}`);
  return out;
}

/** Renders packaging/<path>. */
export async function renderTemplate(path: string, vars: Record<string, string>): Promise<string> {
  return render(await readFile(join(PACKAGING_DIR, path), "utf8"), vars);
}
