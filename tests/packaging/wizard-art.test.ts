import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACK_SIZES, BUTTON_KINDS, BUTTON_SIZE, BUTTON_STATES, SMALL_SIZES, WELCOME_SIZES, WIZARD_THEMES, buttonColors, themeColors, writeWizardArt } from "../../packaging/windows/wizard-art.js";
import { SYSTEM_THEMES } from "../../web/src/lib/themes.js";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
/** Width, height and color type of a PNG. */
const pngHeader = (bytes: Buffer) => ({ signature: bytes.subarray(0, 8).toString("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] });

describe("the installer's wizard art", () => {
  it("follows the app's system themes: Default Light by day, Terminal Dark at night", () => {
    expect(WIZARD_THEMES.map((t) => [t.mode, t.theme])).toEqual([["light", SYSTEM_THEMES.light], ["dark", SYSTEM_THEMES.dark]]);
  });

  it("writes every image at every DPI step, the buttons, and the include files that list them", async () => {
    const out = await mkdtemp(join(tmpdir(), "latch-wizard-"));
    try {
      const files = writeWizardArt(out);
      const buttons = BUTTON_KINDS.length * BUTTON_STATES.length;
      expect(files).toHaveLength(2 * (BACK_SIZES.length + WELCOME_SIZES.length + SMALL_SIZES.length + buttons) + 3);
      for (const mode of ["light", "dark"]) {
        for (const [w, h] of BACK_SIZES) expect(pngHeader(await readFile(join(out, `wizard-back-${mode}-${w}x${h}.png`)))).toEqual({ signature: "89504e470d0a1a0a", width: w, height: h, colorType: 6 });
        for (const [w, h] of WELCOME_SIZES) expect(pngHeader(await readFile(join(out, `wizard-welcome-${mode}-${w}x${h}.png`)))).toMatchObject({ width: w, height: h });
        for (const size of SMALL_SIZES) expect(pngHeader(await readFile(join(out, `wizard-small-${mode}-${size}.png`)))).toMatchObject({ width: size, height: size });
        for (const kind of BUTTON_KINDS) for (const state of BUTTON_STATES) expect(pngHeader(await readFile(join(out, `button-${kind}-${state}-${mode}.png`)))).toMatchObject({ width: BUTTON_SIZE[0], height: BUTTON_SIZE[1] });
      }
      const light = await readFile(join(out, "wizard-art.iss"), "utf8");
      const dark = await readFile(join(out, "wizard-art-dark.iss"), "utf8");
      expect(light).toMatch(/^WizardBackColor=#[0-9a-f]{6}$/m);
      expect(light).toMatch(/^WizardBackImageFile=.*wizard-back-light-596x432\.png,/m);
      expect(light).toMatch(/^WizardImageFile=.*wizard-welcome-light-202x386\.png,/m);
      expect(light).toMatch(/^WizardSmallImageFile=.*wizard-small-light-58\.png,/m);
      expect(dark).toMatch(/^WizardBackImageFileDynamicDark=.*wizard-back-dark-1630x1148\.png$/m);
      for (const directive of ["WizardBackColorDynamicDark", "WizardImageFileDynamicDark", "WizardSmallImageFileDynamicDark"]) expect(dark).toMatch(new RegExp(`^${directive}=`, "m"));
      // Every color latchverify.iss's [Code] reads.
      const iss = read("packaging/windows/latchverify.iss");
      for (const [, name] of iss.matchAll(/\{#(ButtonText_\w+)\}/g)) expect(light + dark).toMatch(new RegExp(`^#define ${name} "#[0-9a-f]{6}"$`, "m"));
      const listed = await readFile(join(out, "wizard-files.iss"), "utf8");
      for (const kind of BUTTON_KINDS) for (const state of BUTTON_STATES) for (const mode of ["light", "dark"]) expect(listed).toContain(`button-${kind}-${state}-${mode}.png"; Flags: dontcopy noencryption`);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("draws the buttons in the app's colors: primary for Next, card and input border for Back and Cancel", () => {
    const colors = themeColors(read("web/src/index.css"), "light");
    expect(buttonColors(colors, "primary", "normal")).toMatchObject({ fill: colors.get("primary"), text: colors.get("primary-foreground"), alpha: 1 });
    expect(buttonColors(colors, "secondary", "normal")).toMatchObject({ fill: colors.get("card"), border: colors.get("input"), text: colors.get("foreground") });
    expect(buttonColors(colors, "secondary", "hover").fill).toEqual(colors.get("muted"));
    expect(buttonColors(colors, "primary", "disabled").alpha).toBe(0.5);
  });

  it("is drawn by the workflow and used by the installer script", () => {
    const iss = read("packaging/windows/latchverify.iss");
    expect(iss).toContain('#if defined(WizardArtDir) && Ver >= EncodeVer(6,6,0)');
    expect(iss).toContain("WizardStyle=modern dynamic windows11 hidebevels");
    for (const file of ["wizard-art.iss", "wizard-art-dark.iss", "wizard-files.iss"]) expect(iss).toContain(`#include AddBackslash(WizardArtDir) + "${file}"`);
    // The drawn buttons press the wizard's own, which stay in the form for Enter and Esc.
    for (const button of ["BackButton", "NextButton", "CancelButton"]) expect(iss).toMatch(new RegExp(`AddThemedButton\\(WizardForm\\.${button}, '(primary|secondary)'\\)`));
    expect(iss).toContain("SetTimer(WizardForm.Handle, 1, 50, CreateCallback(@SyncThemedButtons))");
    const workflow = read(".github/workflows/build-installers.yml");
    expect(workflow).toContain("pnpm -s exec tsx packaging/windows/wizard-art.ts build/wizard");
    expect(workflow).toContain('"/DWizardArtDir=$env:GITHUB_WORKSPACE\\build\\wizard"');
    expect(workflow).toContain('[version]"6.6"');
  });
});
