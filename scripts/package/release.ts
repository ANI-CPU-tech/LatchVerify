import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BuildJobSchema, type BuildJob, type BuildTargetId } from "../../src/schema/index.js";
import { HOMEPAGE, REPO_ROOT } from "./config.js";
import { buildEnv, capture, run, which } from "./process.js";
import { sha256, type Target } from "./targets.js";

/** A release request that cannot be met: nothing built, a changed file, conflicting names. */
export class ReleaseError extends Error {}

export interface ReleaseOptions {
  outputRoot: string;
  version: string;
  targets: Record<BuildTargetId, Target>;
  now: Date;
  env?: NodeJS.ProcessEnv;
}

export interface Release {
  /** build/packages/<version>/release: exactly the files to attach to a release. */
  dir: string;
  assets: string[];
  notesFile: string;
  notes: string;
  targets: BuildTargetId[];
}

interface Asset {
  name: string;
  sha256: string;
  size: number;
  source: string;
  build: BuildJob;
}

/**
 * Assembles a release from the successful builds of `version`:
 *
 *   build/packages/<version>/release/   every package once, SHA256SUMS, and SHA256SUMS.asc
 *                                       when LATCH_GPG_KEY_ID names a signing key
 *   build/packages/<version>/RELEASE_NOTES.md
 *
 * Every artifact is re-hashed against its build record first. Two builds may ship a file with
 * the same name only if the bytes are identical. Local files only: nothing is uploaded.
 */
export async function assembleRelease(options: ReleaseOptions): Promise<Release> {
  const env = options.env ?? process.env;
  const versionDir = join(options.outputRoot, options.version);
  const builds: BuildJob[] = [];
  for (const id of Object.keys(options.targets)) {
    try {
      const job = BuildJobSchema.parse(JSON.parse(await readFile(join(versionDir, id, "build.json"), "utf8")));
      if (job.status === "succeeded" && job.version === options.version) builds.push(job);
    } catch {
      // not built
    }
  }
  if (builds.length === 0) throw new ReleaseError(`no successful builds of ${options.version} to release; build a package first`);

  const assets = new Map<string, Asset>();
  for (const build of builds) {
    for (const artifact of build.artifacts) {
      const source = resolve(REPO_ROOT, artifact.path);
      const actual = await sha256(source).catch(() => null);
      if (actual !== artifact.sha256) throw new ReleaseError(`${artifact.path} changed or disappeared since it was built; rebuild ${build.target}`);
      const seen = assets.get(artifact.name);
      if (seen && seen.sha256 !== artifact.sha256) {
        throw new ReleaseError(`${build.target} and ${seen.build.target} both produced ${artifact.name} with different contents`);
      }
      if (!seen) assets.set(artifact.name, { name: artifact.name, sha256: artifact.sha256, size: artifact.size, source, build });
    }
  }

  const dir = join(versionDir, "release");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const asset of assets.values()) await copyFile(asset.source, join(dir, asset.name));
  await writeFile(join(dir, "SHA256SUMS"), [...assets.values()].map((a) => `${a.sha256}  ${a.name}\n`).join(""));
  const files = [...assets.keys(), "SHA256SUMS"];
  const signed = await signChecksums(dir, env);
  if (signed) files.push("SHA256SUMS.asc");

  const notes = await releaseNotes(options, builds, [...assets.values()], signed, env);
  const notesFile = join(versionDir, "RELEASE_NOTES.md");
  await writeFile(notesFile, notes);
  return { dir, assets: files.map((name) => join(dir, name)), notesFile, notes, targets: builds.map((b) => b.target) };
}

/**
 * Signs SHA256SUMS with gpg when LATCH_GPG_KEY_ID is set (a 16- or 40-digit key id), then checks
 * the signature. LATCH_GPG_PASSPHRASE, if set, goes to gpg on stdin. Returns false when not configured.
 */
async function signChecksums(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const keyId = env.LATCH_GPG_KEY_ID?.trim();
  if (!keyId) return false;
  if (!/^(0x)?([0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/.test(keyId)) throw new ReleaseError("LATCH_GPG_KEY_ID must be a 16- or 40-digit hex key id or fingerprint");
  const gpg = which("gpg", env);
  if (!gpg) throw new ReleaseError("LATCH_GPG_KEY_ID is set but gpg is not installed");
  const passphrase = env.LATCH_GPG_PASSPHRASE;
  const toolEnv = buildEnv({ ...(env.GNUPGHOME ? { GNUPGHOME: env.GNUPGHOME } : {}) }, env);
  await run(
    gpg,
    [
      "--batch",
      "--yes",
      ...(passphrase !== undefined ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"] : []),
      "--local-user",
      keyId,
      "--armor",
      "--detach-sign",
      "--output",
      "SHA256SUMS.asc",
      "SHA256SUMS",
    ],
    { cwd: dir, env: toolEnv, input: passphrase },
  );
  const check = await capture(gpg, ["--batch", "--verify", "SHA256SUMS.asc", "SHA256SUMS"], { cwd: dir, env: toolEnv });
  if (check.code !== 0) throw new ReleaseError(`gpg could not verify the new SHA256SUMS signature:\n${check.stderr.trim()}`);
  return true;
}

const formatSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Commit subjects since the previous v* tag (or the last 30 commits), without merges. */
async function changesSincePreviousTag(version: string): Promise<string[]> {
  const opts = { cwd: REPO_ROOT, timeoutMs: 20_000 };
  const tags = await capture("git", ["tag", "--list", "v*", "--sort=-v:refname", "--merged", "HEAD"], opts).catch(() => null);
  const previous = tags?.code === 0 ? tags.stdout.split("\n").map((t) => t.trim()).find((t) => t !== "" && t !== `v${version}`) : undefined;
  const range = previous ? [`${previous}..HEAD`] : ["-30", "HEAD"];
  const log = await capture("git", ["log", "--no-merges", "--format=%s", ...range], opts).catch(() => null);
  if (!log || log.code !== 0) return [];
  return log.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** "owner/repo" for attestation commands: GITHUB_REPOSITORY in CI, else the homepage. */
const repository = (env: NodeJS.ProcessEnv): string => env.GITHUB_REPOSITORY ?? HOMEPAGE.replace(/^https:\/\/github\.com\//, "");

async function releaseNotes(options: ReleaseOptions, builds: BuildJob[], assets: Asset[], signed: boolean, env: NodeJS.ProcessEnv): Promise<string> {
  const { version, targets } = options;
  const commits = [...new Set(builds.map((b) => b.commit ?? "unknown"))];
  const authenticode = (build: BuildJob) => build.checks.find((c) => c.name === "Authenticode signature")?.status === "pass";
  const rows = assets.map((a) => {
    const note = a.build.target === "windows-installer" ? (authenticode(a.build) ? " (Authenticode-signed)" : " (**unsigned**)") : "";
    return `| ${targets[a.build.target].platform} | \`${a.name}\`${note} | ${formatSize(a.size)} |`;
  });
  const changes = await changesSincePreviousTag(version);
  const unsignedInstaller = builds.some((b) => b.target === "windows-installer" && !authenticode(b));
  const install = builds
    .filter((b) => b.artifacts.length > 0)
    .map((b) => targets[b.target].install(version).replace(/^# /m, "### ").replace(/^## /gm, "#### "))
    .join("\n");
  const example = assets[0]?.name ?? "FILE";

  return `# LatchVerify ${version}

Built from commit ${commits.map((c) => `\`${c}\``).join(", ")} on ${options.now.toISOString().slice(0, 10)}.
${commits.some((c) => c.endsWith("-dirty")) ? "\n> **Warning:** at least one package was built from a work tree with uncommitted changes.\n" : ""}${unsignedInstaller ? "\n> **Warning:** the Windows installer is not code-signed. Smart App Control and SmartScreen will block it.\n" : ""}
## Downloads

All packages need **Node.js 22 or newer**. One package per format runs on every CPU architecture.

| Platform | File | Size |
|---|---|---|
${rows.join("\n")}

## What's changed

${changes.length > 0 ? changes.map((subject) => `- ${subject}`).join("\n") : "<!-- Summarize the changes since the previous release. -->"}

## Verify your download

\`\`\`sh
sha256sum --ignore-missing -c SHA256SUMS${signed ? "\ngpg --verify SHA256SUMS.asc SHA256SUMS" : ""}
gh attestation verify ${example} --repo ${repository(env)}   # build provenance, for files published by the release workflow
\`\`\`

## Install

${install}`;
}
