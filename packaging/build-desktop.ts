/**
 * Build the LatchVerify desktop app (Electron) from a staged app, after packaging/stage.ts:
 *
 *   <stage>/desktop/latchverify-desktop[.exe]   the app, with resources/app = <stage>/app
 *
 * The staged app already holds production dependencies only, so nothing is pruned, and Electron
 * itself is not one of them: packager adds the Electron release named in devDependencies. The
 * bundled package.json's main points at the desktop entry; the CLI keeps running on the bundled
 * Node.js from <stage>/app.
 *
 * Usage: pnpm -s exec tsx packaging/build-desktop.ts <stage-dir> [linux|win32] [x64|arm64]
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSanitizePackageJson, packager } from "@electron/packager";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The desktop entry, relative to the app; `pnpm build` writes it. */
export const DESKTOP_MAIN = "dist/desktop/main.js";
/** The app's executable name, without .exe; the installers and the autostart entries use it. */
export const DESKTOP_EXECUTABLE = "latchverify-desktop";

/** Download failures worth another try: a GitHub 5xx or 429, a timeout, a dropped connection. */
export function isTransientDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}` : String(error);
  return /Response code (5\d\d|429)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network timeout/i.test(message);
}

/** Runs `attempt`, again after `delays[i]` ms while it fails with a transient download error. */
export async function withDownloadRetries<T>(attempt: () => Promise<T>, delays: readonly number[] = [15_000, 45_000], log: (line: string) => void = console.error): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= delays.length || !isTransientDownloadError(error)) throw error;
      log(`build-desktop: ${error instanceof Error ? error.message : String(error)}; retrying in ${delays[i]! / 1000} s`);
      await new Promise((done) => setTimeout(done, delays[i]));
    }
  }
}

export async function buildDesktop(stageDir: string, platform: "linux" | "win32", arch: "x64" | "arm64"): Promise<string> {
  const stage = resolve(stageDir);
  const app = join(stage, "app");
  if (!existsSync(join(app, DESKTOP_MAIN))) throw new Error(`${join(app, DESKTOP_MAIN)} is missing: run \`pnpm build\` and packaging/stage.ts first`);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; devDependencies: Record<string, string> };
  const electronVersion = pkg.devDependencies.electron;
  if (!electronVersion || !/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error("package.json must pin an exact electron version in devDependencies");

  const out = join(stage, "desktop-build");
  rmSync(out, { recursive: true, force: true });
  // Electron comes from GitHub's release downloads, which answer 504 now and then.
  const [built] = await withDownloadRetries(() => packager({
    dir: app,
    out,
    name: "LatchVerify",
    executableName: DESKTOP_EXECUTABLE,
    appVersion: pkg.version,
    electronVersion,
    platform,
    arch,
    asar: false,
    prune: false,
    overwrite: true,
    quiet: true,
    icon: join(root, "packaging", "windows", "latchverify.ico"),
    win32metadata: { CompanyName: "LatchVerify contributors", FileDescription: "LatchVerify", ProductName: "LatchVerify" },
    sanitizePackageJson: [defaultSanitizePackageJson, (json) => ({ ...json, main: DESKTOP_MAIN })],
  }));
  if (!built) throw new Error("electron packager built nothing");
  const desktop = join(stage, "desktop");
  rmSync(desktop, { recursive: true, force: true });
  renameSync(built, desktop);
  // packager builds in a private temp directory (0700); installed as root, users could not enter it.
  chmodSync(desktop, 0o755);
  rmSync(out, { recursive: true, force: true });
  return desktop;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stageDir, platform = process.platform, arch = "x64"] = process.argv.slice(2);
  if (!stageDir || (platform !== "linux" && platform !== "win32") || (arch !== "x64" && arch !== "arm64")) {
    console.error("usage: tsx packaging/build-desktop.ts <stage-dir> [linux|win32] [x64|arm64]");
    process.exit(2);
  }
  buildDesktop(stageDir, platform, arch).then(
    (desktop) => console.log(`built the LatchVerify desktop app in ${desktop}`),
    (error: unknown) => {
      console.error(`build-desktop: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
