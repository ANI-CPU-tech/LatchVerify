import { describe, expect, it } from "vitest";
import { archVersion, debVersion, parseVersion, windowsVersion } from "../../packaging/version.js";

describe("parseVersion", () => {
  it("accepts releases and prereleases", () => {
    expect(parseVersion("1.2.3")).toEqual({ core: "1.2.3" });
    expect(parseVersion("0.1.0-rc.1")).toEqual({ core: "0.1.0", pre: "rc.1" });
  });

  it.each(["", "1.2", "v1.2.3", "1.2.3-", "1.2.3+build", "1.2.3-rc_1", "latest"])("rejects %j", (version) => {
    expect(() => parseVersion(version)).toThrow(/not a release version/);
  });
});

describe("package versions", () => {
  it("formats each package's version so a prerelease sorts before its release", () => {
    expect(debVersion("1.2.3")).toBe("1.2.3");
    expect(debVersion("1.2.3-rc.1")).toBe("1.2.3~rc.1");
    expect(debVersion("1.2.3-beta-2")).toBe("1.2.3~beta.2");
    expect(archVersion("1.2.3")).toBe("1.2.3");
    expect(archVersion("1.2.3-rc.1")).toBe("1.2.3rc1");
    expect(windowsVersion("1.2.3")).toBe("1.2.3.0");
    expect(windowsVersion("1.2.3-rc.1")).toBe("1.2.3.0");
  });
});
