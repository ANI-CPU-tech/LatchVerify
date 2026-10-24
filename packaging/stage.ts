/**
 * Stage the app every LatchVerify package ships, after `pnpm build`:
 *
 *   <out>/app/package.json, LICENSE, README.md
 *   <out>/app/dist/              the CLI (dist/cli.js) and the review UI (dist/web)
 *   <out>/app/node_modules/      production dependencies, from pnpm-lock.yaml, flat
 *
 * Dependencies are installed by pnpm from the committed lockfile (frozen, scripts off) with the
 * hoisted linker, so node_modules holds plain directories and no symlinks, which every package
 * format (zip, Inno Setup, deb, pacman) can carry. The Node.js runtime is added per platform by
 * the workflow (packaging/*\/fetch-node.*); this script only stages the JavaScript app.
 *
 * Usage: pnpm exec tsx packaging/stage.ts <out-dir>
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./version.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Files the build must have produced; staging stops when one is missing. */
export const REQUIRED_BUILD_OUTPUT = ["dist/cli.js", "dist/web/index.html"] as const;

export function stage(out: string): { app: string; version: string } {
  for (const file of REQUIRED_BUILD_OUTPUT) {
    if (!existsSync(join(root, file))) throw new Error(`${file} is missing: run \`pnpm build\` first`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
  parseVersion(pkg.version);

  const app = join(resolve(out), "app");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSE", "README.md"]) cpSync(join(root, file), join(app, file));
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });

  // Production dependencies only, exactly as locked, without running any install scripts.
  execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"], {
    cwd: app,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  // The lockfile and pnpm settings were only needed for that install.
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) rmSync(join(app, file));
  rmSync(join(app, "node_modules", ".pnpm"), { recursive: true, force: true });
  writeFileSync(join(resolve(out), "VERSION"), `${pkg.version}\n`);
  return { app, version: pkg.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: tsx packaging/stage.ts <out-dir>");
    process.exit(2);
  }
  const { app, version } = stage(out);
  console.log(`staged LatchVerify ${version} in ${app}`);
}
