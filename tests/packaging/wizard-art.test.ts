import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LARGE_SIZES, SMALL_SIZES, WIZARD_THEMES, writeWizardArt } from "../../packaging/windows/wizard-art.js";
import { SYSTEM_THEMES } from "../../web/src/lib/themes.js";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
/** Width, height and color type of a PNG. */
const pngHeader = (bytes: Buffer) => ({ signature: bytes.subarray(0, 8).toString("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] });

describe("the installer's wizard art", () => {
  it("follows the app's system themes: Default Light by day, Terminal Dark at night", () => {
    expect(WIZARD_THEMES.map((t) => [t.mode, t.theme])).toEqual([["light", SYSTEM_THEMES.light], ["dark", SYSTEM_THEMES.dark]]);
  });

  it("writes an RGBA PNG at every DPI step, and the include files that list them", async () => {
    const out = await mkdtemp(join(tmpdir(), "latch-wizard-"));
    try {
      const files = writeWizardArt(out);
      expect(files).toHaveLength(2 * (LARGE_SIZES.length + SMALL_SIZES.length) + 2);
      for (const mode of ["light", "dark"]) {
        for (const [w, h] of LARGE_SIZES) expect(pngHeader(await readFile(join(out, `wizard-${mode}-${w}x${h}.png`)))).toEqual({ signature: "89504e470d0a1a0a", width: w, height: h, colorType: 6 });
        for (const size of SMALL_SIZES) expect(pngHeader(await readFile(join(out, `wizard-small-${mode}-${size}.png`)))).toMatchObject({ width: size, height: size });
      }
      const light = await readFile(join(out, "wizard-art.iss"), "utf8");
      const dark = await readFile(join(out, "wizard-art-dark.iss"), "utf8");
      expect(light).toMatch(/^WizardImageFile=.*wizard-light-164x314\.png,/m);
      expect(light).toMatch(/^WizardSmallImageFile=.*wizard-small-light-58\.png,/m);
      expect(dark).toMatch(/^WizardImageFileDynamicDark=.*wizard-dark-410x797\.png$/m);
      expect(dark).toMatch(/^WizardSmallImageFileDynamicDark=/m);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30_000);

  it("is drawn by the workflow and used by the installer script", () => {
    const iss = read("packaging/windows/latchverify.iss");
    expect(iss).toContain('#if defined(WizardArtDir) && Ver >= EncodeVer(6,6,0)');
    expect(iss).toContain("WizardStyle=modern dynamic");
    for (const file of ["wizard-art.iss", "wizard-art-dark.iss"]) expect(iss).toContain(`#include AddBackslash(WizardArtDir) + "${file}"`);
    const workflow = read(".github/workflows/build-installers.yml");
    expect(workflow).toContain("pnpm -s exec tsx packaging/windows/wizard-art.ts build/wizard");
    expect(workflow).toContain('"/DWizardArtDir=$env:GITHUB_WORKSPACE\\build\\wizard"');
    expect(workflow).toContain('[version]"6.6"');
  });
});
