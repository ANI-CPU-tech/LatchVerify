import { describe, expect, it } from "vitest";
import { archVersion, debVersion } from "../../packaging/version.js";
import { downloads } from "../../packaging/release-notes.js";
import {
  FILE_PATTERNS,
  PACKAGE_KINDS,
  RELEASES_URL,
  compareVersions,
  derivedRelease,
  formatBytes,
  formatDate,
  installCommand,
  parseRelease,
  releaseFields,
} from "../../site/src/lib/release.js";

const download = (tag: string, name: string) => `${RELEASES_URL}/download/${tag}/${name}`;

/** The shape of GET /repos/{repo}/releases/latest, trimmed to what the site reads (v0.2.3 as published). */
function apiRelease(overrides: Record<string, unknown> = {}) {
  const asset = (name: string, size: number, digest: string) => ({ name, size, digest, browser_download_url: download("v0.2.3", name) });
  return {
    tag_name: "v0.2.3",
    html_url: `${RELEASES_URL}/tag/v0.2.3`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-05T17:47:05Z",
    assets: [
      asset("latchverify-0.2.3-linux-x64.tar.gz", 171431035, "sha256:1c24a537c9c655fa4d1743fe2ec3f180302527388f07f23282af0ec6d127067e"),
      asset("latchverify-0.2.3-windows-x64-setup.exe", 139063136, "sha256:4059de75fd7380ddd0e2e868960b51d59b9673a563bb9be4aec96e3153216b78"),
      asset("latchverify-bin-0.2.3-1-x86_64.pkg.tar.zst", 162168427, "sha256:f2aa710ab661051ee7dc4846c5e81d529a51d6c3bc384c94bac5541e9e226d0f"),
      asset("latchverify_0.2.3_amd64.deb", 130474442, "sha256:a2014ab12974437b9f36164f89e9db2f539853ecd6778ebe6d818ee5890336c5"),
      asset("latest.json", 1702, "sha256:3b9da1dfe3c0a7b7c9da2bce032b1e1b155b7488789db52b07c43c630f7e15dd"),
      asset("SHA256SUMS", 410, "sha256:dea3b54c2df1c1620acf4bb14f894fd70e05e6f633b95ffb1cb38b886feccee5"),
    ],
    ...overrides,
  };
}

describe("parseRelease", () => {
  it("reads every package of a published release, with size and SHA-256", () => {
    const release = parseRelease(apiRelease())!;
    expect(release.version).toBe("0.2.3");
    expect(release.source).toBe("github");
    expect(release.publishedAt).toBe("2026-11-05T17:47:05Z");
    expect(release.sums).toBe(download("v0.2.3", "SHA256SUMS"));
    expect(release.files.deb).toEqual({
      name: "latchverify_0.2.3_amd64.deb",
      url: download("v0.2.3", "latchverify_0.2.3_amd64.deb"),
      size: 130474442,
      sha256: "a2014ab12974437b9f36164f89e9db2f539853ecd6778ebe6d818ee5890336c5",
    });
    expect(Object.keys(release.files).sort()).toEqual([...PACKAGE_KINDS].sort());
  });

  it("refuses drafts, pre-releases and answers that are not a release of this repository", () => {
    expect(parseRelease(apiRelease({ draft: true }))).toBeNull();
    expect(parseRelease(apiRelease({ prerelease: true }))).toBeNull();
    expect(parseRelease(apiRelease({ tag_name: "latest" }))).toBeNull();
    expect(parseRelease(apiRelease({ html_url: "https://github.com/someone/else/releases/tag/v0.2.3" }))).toBeNull();
    expect(parseRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease([])).toBeNull();
  });

  it("drops an asset whose link points anywhere but this release's downloads", () => {
    const json = apiRelease();
    json.assets[3] = { ...json.assets[3]!, browser_download_url: "https://example.com/latchverify_0.2.3_amd64.deb" };
    expect(parseRelease(json)!.files.deb).toBeUndefined();
    json.assets[3] = { ...json.assets[3]!, browser_download_url: download("v0.2.2", "latchverify_0.2.3_amd64.deb") };
    expect(parseRelease(json)!.files.deb).toBeUndefined();
  });

  it("keeps a file without a size or digest it cannot trust", () => {
    const json = apiRelease();
    json.assets[1] = { ...json.assets[1]!, size: -1, digest: "md5:abc" };
    expect(parseRelease(json)!.files.windows).toEqual({
      name: "latchverify-0.2.3-windows-x64-setup.exe",
      url: download("v0.2.3", "latchverify-0.2.3-windows-x64-setup.exe"),
    });
  });
});

describe("derivedRelease", () => {
  it("names each file as packaging/release-notes.ts and the release workflow do", () => {
    for (const version of ["0.2.3", "1.4.0", "0.2.0-rc.1"]) {
      const release = derivedRelease(version, { deb: debVersion(version), arch: archVersion(version) });
      const table = downloads(version);
      for (const kind of PACKAGE_KINDS) expect(table, kind).toContain(release.files[kind]!.name);
    }
    for (const version of ["0.2.3", "1.4.0"]) {
      const release = derivedRelease(version, { deb: debVersion(version), arch: archVersion(version) });
      expect(release.files.windows!.name).toBe(`latchverify-${version}-windows-x64-setup.exe`);
      expect(release.files.tarball!.name).toBe(`latchverify-${version}-linux-x64.tar.gz`);
      expect(release.files.deb!.name).toBe(`latchverify_${version}_amd64.deb`);
      expect(release.files.arch!.name).toBe(`latchverify-bin-${version}-1-x86_64.pkg.tar.zst`);
      for (const kind of PACKAGE_KINDS) {
        expect(release.files[kind]!.name).toMatch(FILE_PATTERNS[kind]);
        expect(release.files[kind]!.url).toBe(download(`v${version}`, release.files[kind]!.name));
      }
    }
  });

  it("spells a pre-release deb as GitHub stores it, with a dot for the tilde", () => {
    const version = "0.2.0-rc.1";
    const release = derivedRelease(version, { deb: debVersion(version), arch: archVersion(version) });
    // The names v0.2.0-rc.1 was published with.
    expect(release.files.deb!.name).toBe("latchverify_0.2.0.rc.1_amd64.deb");
    expect(release.files.arch!.name).toBe("latchverify-bin-0.2.0rc1-1-x86_64.pkg.tar.zst");
  });

  it("refuses something that is not a version", () => {
    expect(() => derivedRelease("latest", { deb: "latest", arch: "latest" })).toThrow(/not a release version/);
  });
});

describe("helpers", () => {
  it("orders versions, a release above its own pre-releases", () => {
    expect(compareVersions("0.2.3", "0.2.2")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("gives each package its install command", () => {
    expect(installCommand("windows", "latchverify-0.2.3-windows-x64-setup.exe")).toBeNull();
    expect(installCommand("deb", "latchverify_0.2.3_amd64.deb")).toBe("sudo apt install ./latchverify_0.2.3_amd64.deb");
    expect(installCommand("arch", "latchverify-bin-0.2.3-1-x86_64.pkg.tar.zst")).toBe("sudo pacman -U latchverify-bin-0.2.3-1-x86_64.pkg.tar.zst");
    expect(installCommand("tarball", "latchverify-0.2.3-linux-x64.tar.gz")).toBe(
      "tar -xzf latchverify-0.2.3-linux-x64.tar.gz && ./latchverify-0.2.3-linux-x64/install.sh",
    );
  });

  it("formats sizes and dates the way the page shows them", () => {
    expect(formatBytes(130474442)).toBe("124 MB");
    expect(formatBytes(1702)).toBe("1.7 KB");
    expect(formatBytes(410)).toBe("410 B");
    expect(formatDate("2026-11-05T23:47:05Z")).toBe("November 5, 2026");
  });

  it("fills every field the pages use, empty where the data is unknown", () => {
    const live = releaseFields(parseRelease(apiRelease())!);
    expect(live.get("file.windows.size")).toBe("133 MB");
    expect(live.get("release.date")).toBe("November 5, 2026");
    const derived = releaseFields(derivedRelease("0.2.3", { deb: "0.2.3", arch: "0.2.3" }));
    expect(derived.get("file.deb.size")).toBe("");
    expect(derived.get("file.deb.sha")).toBe("");
    expect(derived.get("release.date")).toBe("");
    expect(derived.get("file.deb.cmd")).toBe("sudo apt install ./latchverify_0.2.3_amd64.deb");
    expect([...live.keys()].sort()).toEqual([...derived.keys()].sort());
  });
});
