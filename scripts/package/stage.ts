import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { APP_ID, HOMEPAGE, PACKAGING_DIR, REPO_ROOT, renderTemplate } from "./config.js";
import { ICON_PNG_SIZES, iconIco, iconPng, iconSvg } from "./icon.js";
import { buildEnv, run, type Log } from "./process.js";

export interface StageContext {
  version: string;
  /** Scratch directory owned by this build. */
  workDir: string;
  log: Log;
  /** pnpm as [command, ...leading args] (process.ts resolvePnpm). */
  pnpm: string[];
  /** Release date for AppStream, YYYY-MM-DD. */
  date: string;
}

/** Files that must never be packaged, wherever they appear. */
const FORBIDDEN = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx)|latch\.lock|\.latch)$/i;

/**
 * Fails when `dir` holds a file that looks like a secret or machine-specific state, or (with
 * `noSymlinks`) any symlink. Returns the number of files checked.
 */
export async function assertCleanTree(dir: string, options: { noSymlinks?: boolean } = {}): Promise<number> {
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = relative(dir, join(entry.parentPath, entry.name));
    if (FORBIDDEN.test(entry.name)) throw new Error(`refusing to package ${path}: it looks like a secret or local state`);
    if (options.noSymlinks && entry.isSymbolicLink()) throw new Error(`refusing to package symlink ${path} in an archive that cannot hold one`);
    if (entry.isFile()) files++;
  }
  return files;
}

/** Runs the project's own build (`pnpm run build`: tsc, then the web UI). */
export async function buildProject(ctx: StageContext): Promise<void> {
  const [command, ...args] = ctx.pnpm;
  await run(command!, [...args, "run", "build"], { cwd: REPO_ROOT, env: buildEnv(), log: ctx.log });
}

/** The fields of package.json an installed app needs; scripts and devDependencies are dropped. */
const KEPT_FIELDS = ["name", "description", "type", "license", "bin", "main", "types", "exports", "engines", "dependencies"];

/**
 * Stages the runnable app in <workDir>/app: dist/, production node_modules (installed offline
 * from the local pnpm store, hoisted so there are no symlinks), package.json with `version`,
 * LICENSE and README. Requires a prior buildProject().
 */
export async function stageApp(ctx: StageContext): Promise<string> {
  const app = join(ctx.workDir, "app");
  await rm(app, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  await cp(join(REPO_ROOT, "dist"), join(app, "dist"), { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) await copyFile(join(REPO_ROOT, file), join(app, file));

  const [command, ...args] = ctx.pnpm;
  try {
    await run(
      command!,
      [...args, "install", "--prod", "--frozen-lockfile", "--offline", "--ignore-scripts", "--config.node-linker=hoisted"],
      { cwd: app, env: buildEnv({ CI: "true" }), log: ctx.log },
    );
  } catch (error) {
    throw new Error(`installing production dependencies offline failed; run \`pnpm install\` in the repository first.\n${String(error)}`);
  }

  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<string, unknown>;
  const kept: Record<string, unknown> = { version: ctx.version };
  for (const field of KEPT_FIELDS) if (pkg[field] !== undefined) kept[field] = pkg[field];
  await writeFile(join(app, "package.json"), `${JSON.stringify({ name: kept.name, ...kept }, null, 2)}\n`);
  await rm(join(app, "pnpm-lock.yaml"));
  await rm(join(app, "pnpm-workspace.yaml"));
  // pnpm's own bookkeeping: not part of the app.
  for (const entry of await readdir(join(app, "node_modules"))) {
    if (entry.startsWith(".")) await rm(join(app, "node_modules", entry), { recursive: true, force: true });
  }
  await copyFile(join(REPO_ROOT, "LICENSE"), join(app, "LICENSE"));
  await copyFile(join(REPO_ROOT, "README.md"), join(app, "README.md"));
  await chmod(join(app, "dist", "cli.js"), 0o755);
  ctx.log(`staged ${await assertCleanTree(app)} files in ${app}`);
  return app;
}

export const metainfoVars = (ctx: StageContext) => ({ APP_ID, HOMEPAGE, VERSION: ctx.version, DATE: ctx.date });

/**
 * Lays out a Linux prefix (/usr, /app or a portable directory) under `prefix`:
 *   bin/latch -> ../lib/latchverify/dist/cli.js, bin/latchverify-review (launcher),
 *   lib/latchverify/ (the app), share/applications, share/icons/hicolor, share/metainfo.
 */
export async function stageLinuxTree(ctx: StageContext, app: string, prefix: string): Promise<void> {
  await mkdir(join(prefix, "bin"), { recursive: true });
  await cp(app, join(prefix, "lib", "latchverify"), { recursive: true });
  await symlink("../lib/latchverify/dist/cli.js", join(prefix, "bin", "latch"));
  await copyFile(join(PACKAGING_DIR, "linux", "latchverify-review"), join(prefix, "bin", "latchverify-review"));
  await chmod(join(prefix, "bin", "latchverify-review"), 0o755);

  const share = join(prefix, "share");
  await mkdir(join(share, "applications"), { recursive: true });
  await writeFile(join(share, "applications", `${APP_ID}.desktop`), await renderTemplate("linux/latchverify.desktop.in", { APP_ID }));
  await mkdir(join(share, "metainfo"), { recursive: true });
  await writeFile(join(share, "metainfo", `${APP_ID}.metainfo.xml`), await renderTemplate("linux/latchverify.metainfo.xml.in", metainfoVars(ctx)));
  for (const size of ICON_PNG_SIZES) {
    const dir = join(share, "icons", "hicolor", `${size}x${size}`, "apps");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${APP_ID}.png`), iconPng(size));
  }
  const scalable = join(share, "icons", "hicolor", "scalable", "apps");
  await mkdir(scalable, { recursive: true });
  await writeFile(join(scalable, `${APP_ID}.svg`), iconSvg());
}

/** Windows text files use CRLF line endings; cmd.exe misparses labels without them. */
const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/**
 * Lays out the Windows app under <dir>/LatchVerify: latch.cmd, "LatchVerify Review.cmd",
 * latchverify.ico, README.txt and app/. No symlinks: zip and Inno Setup cannot hold them.
 */
export async function stageWindowsTree(ctx: StageContext, app: string, dir: string): Promise<string> {
  const root = join(dir, "LatchVerify");
  await mkdir(root, { recursive: true });
  await cp(app, join(root, "app"), { recursive: true });
  for (const file of ["latch.cmd", "LatchVerify Review.cmd"]) {
    await writeFile(join(root, file), crlf(await readFile(join(PACKAGING_DIR, "windows", file), "utf8")));
  }
  await writeFile(join(root, "latchverify.ico"), iconIco());
  await writeFile(join(root, "README.txt"), crlf(windowsReadme(ctx.version)));
  await assertCleanTree(root, { noSymlinks: true });
  return root;
}

function windowsReadme(version: string): string {
  return `LatchVerify ${version} for Windows

Requires Node.js 22 or newer on PATH (https://nodejs.org/).

  latch.cmd                 the latch command (latch init, latch verify, latch review, ...)
  LatchVerify Review.cmd    opens the review UI for a project; asks for the folder that
                            contains latch.lock when started elsewhere

Add this folder to your PATH so MCP client configs written by "latch init" can start latch.
To uninstall the portable version, delete this folder and remove it from PATH.

${HOMEPAGE}
`;
}
