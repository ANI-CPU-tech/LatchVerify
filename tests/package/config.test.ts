import { describe, expect, it } from "vitest";
import { archPkgver, assertVersion, debianVersion, numericVersion, packager, render } from "../../scripts/package/config.js";
import { BuildRequestSchema } from "../../src/schema/index.js";

describe("render", () => {
  it("fills every placeholder once, leaving other @ signs alone", () => {
    expect(render("v@VERSION@ by @PACKAGER@", { VERSION: "1.0.0", PACKAGER: "A <a@b.c>" })).toBe("v1.0.0 by A <a@b.c>");
  });

  it("throws on a placeholder without a value, and on a value without a placeholder", () => {
    expect(() => render("@VERSION@ @SHA256@", { VERSION: "1" })).toThrow("@SHA256@ has no value");
    expect(() => render("@VERSION@", { VERSION: "1", EXTRA: "x" })).toThrow("no placeholder for @EXTRA@");
  });
});

describe("versions", () => {
  it.each(["0.1.0", "1.2.3", "10.0.0-rc.1", "1.0.0-beta"])("accepts %s", (version) => {
    expect(() => assertVersion(version)).not.toThrow();
  });

  it.each(["", "1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3 ", "1.2.3;rm -rf /", "1.2.3-rc_1", "../1.2.3", "1.2.3/x"])("rejects %j", (version) => {
    expect(() => assertVersion(version)).toThrow();
    expect(BuildRequestSchema.safeParse({ target: "arch", version, arch: "noarch" }).success).toBe(false);
  });

  it("maps to each packaging format's rules", () => {
    expect(archPkgver("1.2.3-rc.1")).toBe("1.2.3rc.1");
    expect(debianVersion("1.2.3")).toBe("1.2.3-1");
    expect(debianVersion("1.2.3-rc.1")).toBe("1.2.3~rc.1-1");
    expect(numericVersion("1.2.3-rc.1")).toBe("1.2.3.0");
  });
});

describe("packager", () => {
  it("defaults to a neutral address and accepts Name <email>", () => {
    expect(packager({})).toMatch(/^LatchVerify contributors <.+@.+>$/);
    expect(packager({ LATCH_PACKAGER: "Jo Doe <jo@example.com>" })).toBe("Jo Doe <jo@example.com>");
  });

  it("rejects values that could break PKGBUILD or Debian control files", () => {
    for (const bad of ["jo@example.com", "Jo <jo@example.com>\nDepends: evil", "Jo <not an email>"]) {
      expect(() => packager({ LATCH_PACKAGER: bad })).toThrow("LATCH_PACKAGER");
    }
  });
});

describe("build requests", () => {
  it("allow only registered targets, the noarch architecture and no extra fields", () => {
    expect(BuildRequestSchema.safeParse({ target: "arch", version: "1.0.0", arch: "noarch" }).success).toBe(true);
    expect(BuildRequestSchema.safeParse({ target: "appimage", version: "1.0.0", arch: "noarch" }).success).toBe(false);
    expect(BuildRequestSchema.safeParse({ target: "arch", version: "1.0.0", arch: "x86_64" }).success).toBe(false);
    expect(BuildRequestSchema.safeParse({ target: "arch", version: "1.0.0", arch: "noarch", command: "sh" }).success).toBe(false);
  });
});
