import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildCheck, BuildTargetId } from "../../src/schema/index.js";
import {
  APP_ID,
  FLATPAK_REFS,
  FLATPAK_RUNTIME_VERSION,
  HOMEPAGE,
  PACKAGING_DIR,
  archPkgver,
  debianVersion,
  numericVersion,
  packager,
  render,
  renderTemplate,
} from "./config.js";
import { buildEnv, capture, resolvePnpm, run, which } from "./process.js";
import { metainfoVars, stageLinuxTree, stageWindowsTree, type StageContext } from "./stage.js";

export interface BuildContext extends StageContext {
  /** Where artifacts go: build/packages/<version>/<target>/. */
  outDir: string;
  /** Seconds since the epoch for archive timestamps (the HEAD commit time), for reproducible archives. */
  sourceDateEpoch: number;
}

export interface Target {
  id: BuildTargetId;
  label: string;
  platform: string;
  format: string;
  /** LatchVerify is pure JavaScript: every package is architecture-independent. */
  arch: "noarch";
  archLabel: string;
  description: string;
  /** Host operating systems this target builds on. */
  hosts: NodeJS.Platform[];
  prerequisites(): Promise<BuildCheck[]>;
  /** Renders the packaging files and runs the validators that are installed. */
  validate(ctx: BuildContext): Promise<BuildCheck[]>;
  /** Builds from the staged app; returns artifact paths inside ctx.outDir. */
  package(ctx: BuildContext, app: string): Promise<string[]>;
  /** Inspects the artifacts. Any "fail" fails the build. */
  verify(ctx: BuildContext, artifacts: string[]): Promise<BuildCheck[]>;
  /** INSTALL.md for this build. */
  install(version: string): string;
}

const pass = (name: string, detail: string): BuildCheck => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): BuildCheck => ({ name, status: "fail", detail });
const skip = (name: string, detail: string): BuildCheck => ({ name, status: "skip", detail });

function hostCheck(hosts: NodeJS.Platform[], hint: string): BuildCheck {
  return hosts.includes(process.platform) ? pass("Host system", process.platform) : fail("Host system", `${process.platform}: ${hint}`);
}

function toolCheck(command: string, hint: string): BuildCheck {
  const path = which(command);
  return path ? pass(command, path) : fail(command, `not found on PATH; ${hint}`);
}

function pnpmCheck(): BuildCheck {
  const pnpm = resolvePnpm();
  return pnpm ? pass("pnpm", pnpm.join(" ")) : fail("pnpm", "not found; run through `pnpm ui` or `pnpm package`");
}

async function versionOutputCheck(name: string, command: string, args: string[], expect: RegExp, hint: string): Promise<BuildCheck> {
  const path = which(command);
  if (!path) return fail(name, `${command} not found on PATH; ${hint}`);
  try {
    const { stdout, stderr } = await capture(path, args, { cwd: PACKAGING_DIR, timeoutMs: 10_000 });
    const out = `${stdout}\n${stderr}`;
    return expect.test(out) ? pass(name, `${path}: ${out.trim().split("\n")[0]}`) : fail(name, `${path} is not ${name}; ${hint}`);
  } catch (error) {
    return fail(name, `${path} could not run: ${String(error)}`);
  }
}

const gnuTar = () => versionOutputCheck("GNU tar", "tar", ["--version"], /GNU tar/, "install GNU tar");

/** bsdtar writes zip archives; Windows 10+ ships it as tar.exe. */
async function zipTool(): Promise<string | null> {
  for (const command of ["bsdtar", "tar"]) {
    const path = which(command);
    if (!path) continue;
    const { stdout } = await capture(path, ["--version"], { cwd: PACKAGING_DIR, timeoutMs: 10_000 }).catch(() => ({ stdout: "" }));
    if (/bsdtar|libarchive/.test(stdout)) return path;
  }
  return null;
}

async function zipCheck(): Promise<BuildCheck> {
  const path = await zipTool();
  return path ? pass("bsdtar (zip)", path) : fail("bsdtar (zip)", "not found; install libarchive (bsdtar), included in Windows 10+ as tar.exe");
}

/** Runs an optional validator; a missing tool is a skip, not a failure. */
async function optionalValidator(name: string, command: string, args: string[], cwd: string): Promise<BuildCheck> {
  const path = which(command);
  if (!path) return skip(name, `${command} is not installed`);
  const { code, stdout, stderr } = await capture(path, args, { cwd, timeoutMs: 60_000 });
  const out = `${stdout}\n${stderr}`.trim();
  return code === 0 ? pass(name, out.split("\n").slice(-1)[0] || "valid") : fail(name, out || `exit status ${code}`);
}

/** Validates the desktop entry, AppStream metadata and launcher rendered for `version`. */
async function validateLinuxFiles(ctx: BuildContext): Promise<BuildCheck[]> {
  const dir = join(ctx.workDir, "validate");
  await mkdir(dir, { recursive: true });
  const desktop = join(dir, `${APP_ID}.desktop`);
  const metainfo = join(dir, `${APP_ID}.metainfo.xml`);
  await writeFile(desktop, await renderTemplate("linux/latchverify.desktop.in", { APP_ID }));
  await writeFile(metainfo, await renderTemplate("linux/latchverify.metainfo.xml.in", metainfoVars(ctx)));
  return [
    pass("Templates", "desktop entry and AppStream metadata rendered"),
    await optionalValidator("Desktop entry", "desktop-file-validate", [desktop], dir),
    await optionalValidator("AppStream metadata", "appstreamcli", ["validate", "--no-net", metainfo], dir),
    await optionalValidator("Launcher script", "sh", ["-n", join(PACKAGING_DIR, "linux", "latchverify-review")], dir),
  ];
}

/** Lists an archive's entries with bsdtar or tar. */
async function listArchive(archive: string): Promise<string[]> {
  const tool = (await zipTool()) ?? which("tar");
  if (!tool) throw new Error("no tar or bsdtar to list the archive");
  const { stdout } = await run(tool, ["-tf", archive], { cwd: PACKAGING_DIR });
  return stdout.split("\n").map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""));
}

function entriesCheck(name: string, entries: string[], required: string[]): BuildCheck {
  const missing = required.filter((path) => !entries.includes(path));
  return missing.length === 0 ? pass(name, `${entries.length} entries, all required files present`) : fail(name, `missing: ${missing.join(", ")}`);
}

/** Runs `latch --version` from an unpacked app and checks it reports the build's version. */
async function versionCheck(cliJs: string, version: string, cwd: string): Promise<BuildCheck> {
  const { code, stdout, stderr } = await capture(process.execPath, [cliJs, "--version"], { cwd, env: buildEnv(), timeoutMs: 30_000 });
  return code === 0 && stdout.trim() === version
    ? pass("latch --version", stdout.trim())
    : fail("latch --version", `expected ${version}, got exit ${code}: ${(stdout || stderr).trim()}`);
}

async function extract(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  const tool = (await zipTool()) ?? which("tar");
  if (!tool) throw new Error("no tar or bsdtar to extract the archive");
  await run(tool, ["-xf", archive, "-C", into], { cwd: into });
}

const portableName = (version: string) => `latchverify-${version}-linux-portable.tar.gz`;

/** The portable Linux archive: latchverify-<version>/{bin,lib,share,INSTALL.md}. Written to `dest`. */
async function buildPortableTarball(ctx: BuildContext, app: string, dest: string): Promise<string> {
  const base = join(ctx.workDir, "portable");
  const root = join(base, `latchverify-${ctx.version}`);
  await stageLinuxTree(ctx, app, root);
  await writeFile(join(root, "INSTALL.md"), TARGETS["linux-tarball"].install(ctx.version));
  await mkdir(dest, { recursive: true });
  const archive = join(dest, portableName(ctx.version));
  await run(
    which("tar")!,
    ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", `--mtime=@${ctx.sourceDateEpoch}`, "-czf", archive, "-C", base, `latchverify-${ctx.version}`],
    // gzip reading a pipe stores no name and a zero timestamp, so the archive is reproducible.
    { cwd: base, env: buildEnv(), log: ctx.log },
  );
  return archive;
}

const LINUX_REQUIRED = (root: string) => [
  `${root}bin/latch`,
  `${root}bin/latchverify-review`,
  `${root}lib/latchverify/dist/cli.js`,
  `${root}lib/latchverify/dist/web/index.html`,
  `${root}lib/latchverify/package.json`,
  `${root}share/applications/${APP_ID}.desktop`,
  `${root}share/metainfo/${APP_ID}.metainfo.xml`,
  `${root}share/icons/hicolor/scalable/apps/${APP_ID}.svg`,
  `${root}share/icons/hicolor/256x256/apps/${APP_ID}.png`,
];

const WINDOWS_REQUIRED = ["LatchVerify/latch.cmd", "LatchVerify/LatchVerify Review.cmd", "LatchVerify/latchverify.ico", "LatchVerify/app/dist/cli.js", "LatchVerify/app/dist/web/index.html"];

/** Inno Setup's compiler: on PATH, or in its default install folders. */
function findIscc(): string | null {
  const onPath = which("iscc");
  if (onPath) return onPath;
  const bases = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")];
  for (const base of bases) {
    if (base && existsSync(join(base, "Inno Setup 6", "ISCC.exe"))) return join(base, "Inno Setup 6", "ISCC.exe");
  }
  return null;
}

/** sha256 placeholder for validating templates before the real archive exists. */
const ZERO_SHA = "0".repeat(64);

export const TARGETS: Record<BuildTargetId, Target> = {
  "linux-tarball": {
    id: "linux-tarball",
    label: "Portable archive",
    platform: "Linux (any distribution)",
    format: ".tar.gz",
    arch: "noarch",
    archLabel: "Any architecture with Node.js 22+",
    description: "Unpack anywhere; bin/latch, the desktop launcher, icons and AppStream metadata included.",
    hosts: ["linux"],
    prerequisites: async () => [hostCheck(["linux"], "build Linux archives on Linux"), pnpmCheck(), await gnuTar()],
    validate: (ctx) => validateLinuxFiles(ctx),
    package: async (ctx, app) => [await buildPortableTarball(ctx, app, ctx.outDir)],
    async verify(ctx, [archive]) {
      const root = `latchverify-${ctx.version}/`;
      const checks = [entriesCheck("Archive contents", await listArchive(archive!), LINUX_REQUIRED(root))];
      const into = join(ctx.workDir, "verify");
      await extract(archive!, into);
      checks.push(await versionCheck(join(into, root, "bin", "latch"), ctx.version, into));
      checks.push(await optionalValidator("Packaged desktop entry", "desktop-file-validate", [join(into, root, "share", "applications", `${APP_ID}.desktop`)], into));
      checks.push(await optionalValidator("Packaged AppStream metadata", "appstreamcli", ["validate", "--no-net", join(into, root, "share", "metainfo", `${APP_ID}.metainfo.xml`)], into));
      return checks;
    },
    install: (version) => `# LatchVerify ${version}: portable Linux archive

Requires Node.js 22 or newer on PATH. Works on any distribution and architecture.

## Install (current user)

\`\`\`sh
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf ${portableName(version)} -C ~/.local/opt
ln -sf ~/.local/opt/latchverify-${version}/bin/latch ~/.local/bin/latch
ln -sf ~/.local/opt/latchverify-${version}/bin/latchverify-review ~/.local/bin/latchverify-review
cp -r ~/.local/opt/latchverify-${version}/share/. ~/.local/share/
\`\`\`

\`~/.local/bin\` must be on PATH: MCP client configs written by \`latch init\` start \`latch\`.
The desktop menu then has a **LatchVerify** entry that opens the review UI.

## Uninstall

\`\`\`sh
rm -rf ~/.local/opt/latchverify-${version} ~/.local/bin/latch ~/.local/bin/latchverify-review
rm -f ~/.local/share/applications/${APP_ID}.desktop ~/.local/share/metainfo/${APP_ID}.metainfo.xml
find ~/.local/share/icons/hicolor -name '${APP_ID}.*' -delete
\`\`\`
`,
  },

  "windows-zip": {
    id: "windows-zip",
    label: "Portable ZIP",
    platform: "Windows 10/11",
    format: ".zip",
    arch: "noarch",
    archLabel: "x64 and arm64 with Node.js 22+",
    description: "Unzip anywhere; latch.cmd and a LatchVerify Review launcher. Builds on Linux or Windows.",
    hosts: ["linux", "win32", "darwin"],
    prerequisites: async () => [hostCheck(["linux", "win32", "darwin"], "unsupported host"), pnpmCheck(), await zipCheck()],
    async validate() {
      const files = await readdir(join(PACKAGING_DIR, "windows"));
      const missing = ["latch.cmd", "LatchVerify Review.cmd"].filter((f) => !files.includes(f));
      return [missing.length === 0 ? pass("Launcher scripts", "latch.cmd and LatchVerify Review.cmd present") : fail("Launcher scripts", `missing ${missing.join(", ")}`)];
    },
    async package(ctx, app) {
      const dir = join(ctx.workDir, "windows");
      await stageWindowsTree(ctx, app, dir);
      const archive = join(ctx.outDir, `latchverify-${ctx.version}-windows-portable.zip`);
      await run((await zipTool())!, ["--format", "zip", "-cf", archive, "-C", dir, "LatchVerify"], { cwd: dir, log: ctx.log });
      return [archive];
    },
    async verify(ctx, [archive]) {
      const checks = [entriesCheck("Archive contents", await listArchive(archive!), WINDOWS_REQUIRED)];
      const into = join(ctx.workDir, "verify");
      await extract(archive!, into);
      const cmd = await readFile(join(into, "LatchVerify", "LatchVerify Review.cmd"), "utf8");
      checks.push(/\r\n/.test(cmd) && !/[^\r]\n/.test(cmd) ? pass("CRLF line endings", "launcher scripts use CRLF") : fail("CRLF line endings", "launcher has bare LF line endings"));
      const ico = await readFile(join(into, "LatchVerify", "latchverify.ico"));
      checks.push(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) > 0 ? pass("Icon", `${ico.readUInt16LE(4)} sizes`) : fail("Icon", "not an .ico file"));
      // The app is plain JavaScript, so this host's Node runs exactly what Windows will run.
      checks.push(await versionCheck(join(into, "LatchVerify", "app", "dist", "cli.js"), ctx.version, into));
      return checks;
    },
    install: (version) => `# LatchVerify ${version}: portable ZIP for Windows

Requires Node.js 22 or newer on PATH (https://nodejs.org/).

## Install

1. Unzip \`latchverify-${version}-windows-portable.zip\`, for example to \`%LOCALAPPDATA%\\Programs\`.
2. Add the \`LatchVerify\` folder to your user PATH (Settings > System > About > Advanced system
   settings > Environment Variables). MCP client configs written by \`latch init\` start \`latch\`.
3. Start **LatchVerify Review.cmd** to open the review UI, or run \`latch\` in a terminal.

## Uninstall

Delete the \`LatchVerify\` folder and remove it from PATH.
`,
  },

  "windows-installer": {
    id: "windows-installer",
    label: "Installer (Inno Setup)",
    platform: "Windows 10/11",
    format: ".exe",
    arch: "noarch",
    archLabel: "x64 and arm64 with Node.js 22+",
    description: "Per-user installer with a Start menu launcher, optional PATH entry and an uninstaller. Builds on Windows only.",
    hosts: ["win32"],
    async prerequisites() {
      const iscc = findIscc();
      return [
        hostCheck(["win32"], "Inno Setup runs on Windows; build there or in the CI workflow (.github/workflows/package.yml)"),
        pnpmCheck(),
        iscc ? pass("Inno Setup 6 (ISCC)", iscc) : fail("Inno Setup 6 (ISCC)", "not found; install Inno Setup 6 from https://jrsoftware.org/isinfo.php"),
      ];
    },
    async validate(ctx) {
      render(await readFile(join(PACKAGING_DIR, "windows", "latchverify.iss.in"), "utf8"), {
        VERSION: ctx.version,
        VERSION_NUMERIC: numericVersion(ctx.version),
        HOMEPAGE,
      });
      return [pass("Installer script", `latchverify.iss renders for ${ctx.version} (${numericVersion(ctx.version)})`)];
    },
    async package(ctx, app) {
      const dir = join(ctx.workDir, "inno");
      await stageWindowsTree(ctx, app, dir);
      await writeFile(
        join(dir, "latchverify.iss"),
        await renderTemplate("windows/latchverify.iss.in", { VERSION: ctx.version, VERSION_NUMERIC: numericVersion(ctx.version), HOMEPAGE }),
      );
      await run(findIscc()!, ["/Qp", "latchverify.iss"], { cwd: dir, log: ctx.log });
      const name = `latchverify-${ctx.version}-windows-setup.exe`;
      await rename(join(dir, "out", name), join(ctx.outDir, name));
      return [join(ctx.outDir, name)];
    },
    async verify(_ctx, [setup]) {
      const head = (await readFile(setup!)).subarray(0, 2).toString("latin1");
      const { size } = await stat(setup!);
      return [head === "MZ" ? pass("Windows executable", `${size} bytes`) : fail("Windows executable", "missing MZ header")];
    },
    install: (version) => `# LatchVerify ${version}: Windows installer

Requires Node.js 22 or newer on PATH (https://nodejs.org/).

## Install

Run \`latchverify-${version}-windows-setup.exe\`. It installs for the current user (no
administrator rights), adds a **LatchVerify Review** Start menu shortcut and, unless you
untick it, adds \`latch\` to your PATH.

## Uninstall

Settings > Apps > Installed apps > LatchVerify > Uninstall. This also removes the PATH entry.
`,
  },

  arch: {
    id: "arch",
    label: "Arch / CachyOS package",
    platform: "Arch Linux, CachyOS, Manjaro",
    format: ".pkg.tar.zst",
    arch: "noarch",
    archLabel: "any (pacman arch=any), needs nodejs>=22",
    description: "A pacman package built with makepkg from a PKGBUILD; the PKGBUILD and its source archive are kept with it.",
    hosts: ["linux"],
    prerequisites: async () => [
      hostCheck(["linux"], "makepkg runs on Arch-based Linux"),
      pnpmCheck(),
      await gnuTar(),
      toolCheck("makepkg", "install pacman (Arch-based distributions)"),
      toolCheck("fakeroot", "sudo pacman -S fakeroot"),
    ],
    async validate(ctx) {
      const checks = await validateLinuxFiles(ctx);
      const pkgbuild = join(ctx.workDir, "validate", "PKGBUILD");
      await writeFile(pkgbuild, await pkgbuildFor(ctx.version, ZERO_SHA));
      checks.push(await optionalValidator("PKGBUILD syntax", "bash", ["-n", pkgbuild], ctx.workDir));
      return checks;
    },
    async package(ctx, app) {
      const dir = join(ctx.workDir, "arch");
      const source = await buildPortableTarball(ctx, app, dir);
      const pkgbuild = await pkgbuildFor(ctx.version, await sha256(source));
      await writeFile(join(dir, "PKGBUILD"), pkgbuild);
      await run(which("makepkg")!, ["--nodeps", "--noconfirm", "--force", "--cleanbuild", "--nosign"], {
        cwd: dir,
        log: ctx.log,
        env: buildEnv({
          PKGDEST: ctx.outDir,
          SRCDEST: dir,
          BUILDDIR: join(dir, "build"),
          PKGEXT: ".pkg.tar.zst",
          PACKAGER: packager(),
          SOURCE_DATE_EPOCH: String(ctx.sourceDateEpoch),
        }),
      });
      await copyFile(join(dir, "PKGBUILD"), join(ctx.outDir, "PKGBUILD"));
      await copyFile(source, join(ctx.outDir, portableName(ctx.version)));
      return [join(ctx.outDir, `latchverify-${archPkgver(ctx.version)}-1-any.pkg.tar.zst`), join(ctx.outDir, "PKGBUILD"), join(ctx.outDir, portableName(ctx.version))];
    },
    async verify(ctx, [pkg]) {
      const entries = await listArchive(pkg!);
      const checks = [entriesCheck("Package contents", entries, [".PKGINFO", ...LINUX_REQUIRED("usr/"), "usr/share/licenses/latchverify/LICENSE"])];
      const into = join(ctx.workDir, "verify");
      await extract(pkg!, into);
      const info = await readFile(join(into, ".PKGINFO"), "utf8");
      const expected = [`pkgver = ${archPkgver(ctx.version)}-1`, "arch = any", "depend = nodejs>=22"];
      const missing = expected.filter((line) => !info.split("\n").includes(line));
      checks.push(missing.length === 0 ? pass(".PKGINFO", expected.join(", ")) : fail(".PKGINFO", `missing ${missing.join(", ")}`));
      checks.push(await versionCheck(join(into, "usr", "lib", "latchverify", "dist", "cli.js"), ctx.version, into));
      checks.push(await optionalValidator("namcap", "namcap", [pkg!], ctx.workDir));
      return checks;
    },
    install: (version) => `# LatchVerify ${version}: Arch Linux / CachyOS package

## Install

\`\`\`sh
sudo pacman -U latchverify-${archPkgver(version)}-1-any.pkg.tar.zst
\`\`\`

pacman pulls in \`nodejs\` (22 or newer). The menu then has a **LatchVerify** entry that opens
the review UI; \`latch\` is in /usr/bin.

To rebuild from the included PKGBUILD, put it next to \`${portableName(version)}\` and run
\`makepkg -si\`.

## Uninstall

\`\`\`sh
sudo pacman -R latchverify
\`\`\`
`,
  },

  deb: {
    id: "deb",
    label: "Debian / Ubuntu package",
    platform: "Debian 13+, Ubuntu 24.04+",
    format: ".deb",
    arch: "noarch",
    archLabel: "all (Architecture: all), needs nodejs>=22",
    description: "A .deb built with dpkg-deb. Ubuntu's own nodejs is older than 22; use NodeSource or a newer release.",
    hosts: ["linux"],
    prerequisites: async () => [
      hostCheck(["linux"], "dpkg-deb runs on Linux"),
      pnpmCheck(),
      await gnuTar(),
      toolCheck("dpkg-deb", "install dpkg (Debian/Ubuntu: preinstalled; Arch: sudo pacman -S dpkg)"),
    ],
    async validate(ctx) {
      const checks = await validateLinuxFiles(ctx);
      const control = await controlFor(ctx.version, 1);
      const fields = control.split("\n").filter((line) => /^[A-Z][\w-]*: /.test(line)).map((line) => line.split(":")[0]);
      const required = ["Package", "Version", "Architecture", "Maintainer", "Description"];
      const missing = required.filter((field) => !fields.includes(field));
      checks.push(missing.length === 0 ? pass("Debian control", `Version: ${debianVersion(ctx.version)}`) : fail("Debian control", `missing ${missing.join(", ")}`));
      return checks;
    },
    async package(ctx, app) {
      const root = join(ctx.workDir, "deb", "root");
      await stageLinuxTree(ctx, app, join(root, "usr"));
      const doc = join(root, "usr", "share", "doc", "latchverify");
      await mkdir(doc, { recursive: true });
      await writeFile(join(doc, "copyright"), `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nUpstream-Name: latchverify\nSource: ${HOMEPAGE}\n\nFiles: *\nLicense: MIT\n ${(await readFile(join(app, "LICENSE"), "utf8")).trim().split("\n").map((l) => l || ".").join("\n ")}\n`);
      await mkdir(join(root, "DEBIAN"), { recursive: true });
      await writeFile(join(root, "DEBIAN", "control"), await controlFor(ctx.version, await sizeKb(join(root, "usr"))));
      const name = `latchverify_${debianVersion(ctx.version)}_all.deb`;
      await run(which("dpkg-deb")!, ["--root-owner-group", "-Zxz", "--build", root, join(ctx.outDir, name)], {
        cwd: ctx.workDir,
        log: ctx.log,
        env: buildEnv({ SOURCE_DATE_EPOCH: String(ctx.sourceDateEpoch) }),
      });
      return [join(ctx.outDir, name)];
    },
    async verify(ctx, [deb]) {
      const dpkg = which("dpkg-deb")!;
      const { stdout: info } = await run(dpkg, ["--info", deb!], { cwd: ctx.workDir });
      const checks = [info.includes(`Version: ${debianVersion(ctx.version)}`) ? pass("Package metadata", `Version: ${debianVersion(ctx.version)}`) : fail("Package metadata", info.trim())];
      const { stdout: contents } = await run(dpkg, ["--contents", deb!], { cwd: ctx.workDir });
      const paths = contents.split("\n").map((line) => line.split(/\s+/).slice(5).join(" ").split(" -> ")[0]!.replace(/^\.\//, "").replace(/\/$/, ""));
      checks.push(entriesCheck("Package contents", paths, LINUX_REQUIRED("usr/")));
      const into = join(ctx.workDir, "verify");
      await run(dpkg, ["-x", deb!, into], { cwd: ctx.workDir });
      checks.push(await versionCheck(join(into, "usr", "lib", "latchverify", "dist", "cli.js"), ctx.version, into));
      checks.push(await optionalValidator("lintian", "lintian", [deb!], ctx.workDir));
      return checks;
    },
    install: (version) => `# LatchVerify ${version}: Debian / Ubuntu package

Requires the \`nodejs\` package at version 22 or newer. Ubuntu 24.04 and Debian 12 ship older
versions: install Node.js 22 from NodeSource (https://github.com/nodesource/distributions) first.

## Install

\`\`\`sh
sudo apt install ./latchverify_${debianVersion(version)}_all.deb
\`\`\`

The menu then has a **LatchVerify** entry that opens the review UI; \`latch\` is in /usr/bin.

## Uninstall

\`\`\`sh
sudo apt remove latchverify
\`\`\`
`,
  },

  flatpak: {
    id: "flatpak",
    label: "Flatpak bundle (local build)",
    platform: "Any Linux with Flatpak",
    format: ".flatpak",
    arch: "noarch",
    archLabel: `Host architecture (freedesktop ${FLATPAK_RUNTIME_VERSION} runtime)`,
    description: "A local, single-file Flatpak bundle for testing. Not a Flathub release: see packaging/flatpak/FLATHUB.md.",
    hosts: ["linux"],
    async prerequisites() {
      const checks = [hostCheck(["linux"], "Flatpak is Linux-only"), pnpmCheck(), await gnuTar(), toolCheck("flatpak", "install flatpak"), toolCheck("flatpak-builder", "install flatpak-builder")];
      const flatpak = which("flatpak");
      for (const ref of FLATPAK_REFS) {
        if (!flatpak) {
          checks.push(fail(ref, "flatpak is not installed"));
          continue;
        }
        const { code } = await capture(flatpak, ["info", ref], { cwd: PACKAGING_DIR, timeoutMs: 20_000 });
        checks.push(code === 0 ? pass(ref, "installed") : fail(ref, `not installed; flatpak install flathub ${ref}`));
      }
      return checks;
    },
    async validate(ctx) {
      const checks = await validateLinuxFiles(ctx);
      await flatpakManifestFor(ctx.version, ZERO_SHA);
      checks.push(pass("Flatpak manifest", `${APP_ID}.yml renders for runtime ${FLATPAK_RUNTIME_VERSION}`));
      return checks;
    },
    async package(ctx, app) {
      const dir = join(ctx.workDir, "flatpak");
      const source = await buildPortableTarball(ctx, app, dir);
      const manifest = join(dir, `${APP_ID}.yml`);
      await writeFile(manifest, await flatpakManifestFor(ctx.version, await sha256(source)));
      const env = buildEnv();
      await run(which("flatpak-builder")!, ["--disable-download", "--force-clean", "--repo=repo", "--state-dir=state", "build-dir", manifest], { cwd: dir, log: ctx.log, env });
      const bundle = join(ctx.outDir, `latchverify-${ctx.version}.flatpak`);
      await run(which("flatpak")!, ["build-bundle", "repo", bundle, APP_ID], { cwd: dir, log: ctx.log, env });
      await copyFile(manifest, join(ctx.outDir, `${APP_ID}.yml`));
      return [bundle, join(ctx.outDir, `${APP_ID}.yml`)];
    },
    async verify(ctx, [bundle]) {
      const exported = join(ctx.workDir, "flatpak", "build-dir", "export", "share", "applications", `${APP_ID}.desktop`);
      const checks = [(await stat(bundle!)).size > 0 ? pass("Bundle", "written") : fail("Bundle", "empty file")];
      checks.push(await stat(exported).then(() => pass("Exported desktop entry", `${APP_ID}.desktop`), () => fail("Exported desktop entry", "flatpak-builder exported no desktop entry")));
      return checks;
    },
    install: (version) => `# LatchVerify ${version}: local Flatpak bundle

This bundle is a local build for testing. It is not published on Flathub.

## Install

\`\`\`sh
flatpak install --user latchverify-${version}.flatpak
flatpak run ${APP_ID}                              # review UI launcher
flatpak run --command=latch ${APP_ID} --help       # the latch command
\`\`\`

The runtime \`org.freedesktop.Platform//${FLATPAK_RUNTIME_VERSION}\` must be installed (from Flathub).

**Sandbox limits:** the app can read and write your home directory (for latch.lock) and use
the network (so your browser reaches the review UI on 127.0.0.1). \`latch proxy\` cannot start
MCP servers installed on the host from inside the sandbox; use a native package for that.

## Uninstall

\`\`\`sh
flatpak uninstall --user ${APP_ID}
\`\`\`
`,
  },
};

async function pkgbuildFor(version: string, sha: string): Promise<string> {
  return renderTemplate("arch/PKGBUILD.in", { PACKAGER: packager(), PKGVER: archPkgver(version), HOMEPAGE, VERSION: version, SHA256: sha });
}

async function controlFor(version: string, installedSizeKb: number): Promise<string> {
  return renderTemplate("debian/control.in", {
    DEB_VERSION: debianVersion(version),
    INSTALLED_SIZE: String(installedSizeKb),
    PACKAGER: packager(),
    HOMEPAGE,
  });
}

async function flatpakManifestFor(version: string, sha: string): Promise<string> {
  return renderTemplate("flatpak/manifest.yml.in", { APP_ID, RUNTIME_VERSION: FLATPAK_RUNTIME_VERSION, VERSION: version, SHA256: sha });
}

export async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sizeKb(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return Math.ceil(bytes / 1024);
}

export const TARGET_IDS = Object.keys(TARGETS) as BuildTargetId[];
