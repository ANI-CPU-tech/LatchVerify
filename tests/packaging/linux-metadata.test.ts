import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../packaging/${path}`, import.meta.url), "utf8");

// What the desktop app (Electron) links against beyond what the CLI's Node.js needs.
describe("the Linux packages", () => {
  it("the deb recommends what the desktop app needs, without making the CLI depend on a desktop", () => {
    const control = read("debian/control.in");
    const recommends = /^Recommends: (.*)$/m.exec(control)?.[1] ?? "";
    for (const library of ["libgtk-3-0", "libnss3", "libgbm1", "libasound2", "libxss1", "libxtst6", "libatspi2.0-0", "libnotify-bin", "pkexec"]) expect(recommends, library).toContain(library);
    const depends = /^Depends: (.*)$/m.exec(control)?.[1] ?? "";
    expect(depends).not.toContain("libgtk");
  });

  it("the Arch package lists the same as optional, and describes what installing does now", () => {
    const pkgbuild = read("arch/PKGBUILD");
    expect(pkgbuild).toMatch(/optdepends=[\s\S]*'polkit:/);
    for (const library of ["gtk3", "nss", "mesa", "alsa-lib", "libxss", "libxtst", "at-spi2-core", "libnotify"]) expect(pkgbuild, library).toMatch(new RegExp(`optdepends=[\\s\\S]*'${library}:`));
    expect(pkgbuild).not.toContain("links Claude Code on install");
  });
});
