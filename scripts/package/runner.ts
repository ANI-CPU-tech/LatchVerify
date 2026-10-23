import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BuildJobSchema,
  BuildRequestSchema,
  type BuildArtifact,
  type BuildCheck,
  type BuildJob,
  type BuildRequest,
  type BuildTargetId,
  type BuildTargetSummary,
  type ReleaseReport,
} from "../../src/schema/index.js";
import { OUTPUT_ROOT, REPO_ROOT } from "./config.js";
import { capture, resolvePnpm, type Log } from "./process.js";
import { buildProject, stageApp, type StageContext } from "./stage.js";
import { TARGETS, sha256, type BuildContext, type Target } from "./targets.js";

const STEPS = ["Prerequisites", "Configuration", "Build app", "Package", "Verify", "Checksums"] as const;
/** Log lines kept in memory and returned with a job; the full log is on disk. */
const LOG_LINES = 500;

export interface BuildServiceOptions {
  outputRoot?: string;
  targets?: Record<BuildTargetId, Target>;
  /** Replaces `pnpm run build` + staging; tests use it to skip the real build. */
  stage?: (ctx: StageContext) => Promise<string>;
  now?: () => Date;
  /** Receives every log line as it is written (the CLI prints them). */
  onLog?: (jobId: string, line: string) => void;
}

/** A request the build service refuses: bad parameters, an unknown job, nothing to release. */
export class BuildRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs predefined package builds one at a time. Every build is a fixed sequence of steps for a
 * registered target with a validated version; nothing the caller sends is run as a command.
 * A job succeeds only when every prerequisite, validation and verification check passes, and
 * only then lists artifacts.
 */
export class BuildService {
  readonly outputRoot: string;
  private readonly targets: Record<BuildTargetId, Target>;
  private readonly stage: (ctx: StageContext) => Promise<string>;
  private readonly now: () => Date;
  private readonly onLog: ((jobId: string, line: string) => void) | undefined;
  private readonly jobs = new Map<string, BuildJob>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: BuildServiceOptions = {}) {
    this.outputRoot = resolve(options.outputRoot ?? OUTPUT_ROOT);
    this.targets = options.targets ?? TARGETS;
    this.stage =
      options.stage ??
      (async (ctx) => {
        await buildProject(ctx);
        return stageApp(ctx);
      });
    this.now = options.now ?? (() => new Date());
    this.onLog = options.onLog;
  }

  private get jobsDir(): string {
    return join(this.outputRoot, ".jobs");
  }

  /** Repository-relative path with "/" separators, so a record written on Windows reads on Linux. */
  private relative(path: string): string {
    return relative(REPO_ROOT, path).split(sep).join("/") || ".";
  }

  /** Every target with its prerequisites checked on this machine. */
  async listTargets(): Promise<BuildTargetSummary[]> {
    return Promise.all(
      Object.values(this.targets).map(async (target) => {
        const prerequisites = await target.prerequisites();
        return {
          id: target.id,
          label: target.label,
          platform: target.platform,
          format: target.format,
          arch: target.arch,
          archLabel: target.archLabel,
          description: target.description,
          available: prerequisites.every((check) => check.status !== "fail"),
          prerequisites,
        };
      }),
    );
  }

  private target(id: string): Target {
    const target = (this.targets as Record<string, Target | undefined>)[id];
    if (!target) throw new BuildRequestError(400, `unknown target ${JSON.stringify(id)}`);
    return target;
  }

  /** Prerequisites plus configuration validation for a target and version, without building. */
  async check(targetId: string, version: string): Promise<{ checks: BuildCheck[]; ready: boolean }> {
    const request = parseRequest({ target: targetId, version, arch: "noarch" });
    const target = this.target(request.target);
    const workDir = join(this.outputRoot, ".work", `check-${randomBytes(4).toString("hex")}`);
    try {
      const checks = [...(await target.prerequisites())];
      checks.push(...(await target.validate(await this.context(request, workDir, () => undefined))));
      return { checks, ready: checks.every((check) => check.status !== "fail") };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Queues a build. Returns at once; poll job(id) for progress. */
  start(input: unknown): BuildJob {
    const request = parseRequest(input);
    this.target(request.target);
    const id = `${this.now().getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
    const job: BuildJob = {
      id,
      ...request,
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      commit: null,
      steps: STEPS.map((name) => ({ name, status: "pending" })),
      checks: [],
      artifacts: [],
      outputDir: this.relative(this.outDir(request)),
      error: null,
      log: [],
    };
    this.jobs.set(id, job);
    this.tail = this.tail.then(() => this.execute(job));
    return structuredClone(job);
  }

  /** Resolves when every queued build has finished. */
  idle(): Promise<void> {
    return this.tail;
  }

  /** A job from this session or an earlier one, with the tail of its log. */
  async job(id: string): Promise<BuildJob> {
    const live = this.jobs.get(id);
    if (live) return structuredClone(live);
    if (!/^[a-z0-9]+-[a-f0-9]{6}$/.test(id)) throw new BuildRequestError(404, `no build ${JSON.stringify(id)}`);
    const stored = await this.readStoredJob(join(this.jobsDir, `${id}.json`));
    if (!stored) throw new BuildRequestError(404, `no build ${JSON.stringify(id)}`);
    const log = await readFile(join(this.jobsDir, `${id}.log`), "utf8").catch(() => "");
    return { ...stored, log: log.split("\n").filter((line) => line !== "").slice(-LOG_LINES) };
  }

  /** All builds, newest first, without logs. */
  async listJobs(): Promise<BuildJob[]> {
    const all = new Map<string, BuildJob>();
    let names: string[] = [];
    try {
      names = await readdir(this.jobsDir);
    } catch {
      // no builds yet
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const job = await this.readStoredJob(join(this.jobsDir, name));
      if (job) all.set(job.id, job);
    }
    for (const job of this.jobs.values()) all.set(job.id, structuredClone(job));
    return [...all.values()].map((job) => ({ ...job, log: [] })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Absolute path of an artifact of a successful build, or a 404. Names come from the job record. */
  async artifactFile(id: string, name: string): Promise<string> {
    const job = await this.job(id);
    const artifact = job.status === "succeeded" ? job.artifacts.find((a) => a.name === name) : undefined;
    if (!artifact) throw new BuildRequestError(404, `build ${id} has no artifact ${JSON.stringify(name)}`);
    const path = resolve(REPO_ROOT, artifact.path);
    if (!isInside(this.outputRoot, path)) throw new BuildRequestError(404, "artifact is outside the output directory");
    return path;
  }

  /** A stored record; one that never finished (the server stopped mid-build) reads as failed. */
  private async readStoredJob(path: string): Promise<BuildJob | null> {
    try {
      const job = BuildJobSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if ((job.status === "queued" || job.status === "running") && !this.jobs.has(job.id)) {
        return { ...job, status: "failed", artifacts: [], error: "interrupted: the build server stopped before this build finished" };
      }
      return job;
    } catch {
      return null;
    }
  }

  private outDir(request: BuildRequest): string {
    return join(this.outputRoot, request.version, request.target);
  }

  private async context(request: BuildRequest, workDir: string, log: Log): Promise<BuildContext> {
    await mkdir(workDir, { recursive: true });
    const pnpm = resolvePnpm() ?? ["pnpm"];
    const epoch = await capture("git", ["log", "-1", "--format=%ct"], { cwd: REPO_ROOT, timeoutMs: 10_000 }).catch(() => null);
    const sourceDateEpoch = Number(epoch?.stdout.trim()) || Math.floor(this.now().getTime() / 1000);
    return {
      version: request.version,
      workDir,
      log,
      pnpm,
      date: this.now().toISOString().slice(0, 10),
      outDir: this.outDir(request),
      sourceDateEpoch,
    };
  }

  private async execute(job: BuildJob): Promise<void> {
    const target = this.targets[job.target];
    const workDir = join(this.outputRoot, ".work", job.id);
    const logFile = join(this.jobsDir, `${job.id}.log`);
    await mkdir(this.jobsDir, { recursive: true });
    let pendingLog = Promise.resolve();
    const log: Log = (line) => {
      this.onLog?.(job.id, line);
      job.log.push(line);
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
      pendingLog = pendingLog.then(() => appendFile(logFile, `${line}\n`)).catch(() => undefined);
    };
    const step = async <T,>(index: number, run: () => Promise<T>): Promise<T> => {
      job.steps[index]!.status = "running";
      log(`== ${STEPS[index]}`);
      const result = await run();
      job.steps[index]!.status = "passed";
      return result;
    };
    const requirePass = (checks: BuildCheck[], what: string) => {
      job.checks.push(...checks);
      for (const check of checks) log(`[${check.status}] ${check.name}: ${check.detail}`);
      const failed = checks.filter((check) => check.status === "fail");
      if (failed.length > 0) throw new Error(`${what} failed: ${failed.map((check) => check.name).join(", ")}`);
    };

    job.status = "running";
    job.startedAt = this.now().toISOString();
    job.commit = await commitOf();
    await this.persist(job);
    const ctx = await this.context(job, workDir, log);
    let artifacts: BuildArtifact[] = [];
    try {
      await step(0, async () => requirePass(await target.prerequisites(), "prerequisites"));
      await step(1, async () => requirePass(await target.validate(ctx), "configuration"));
      const app = await step(2, () => this.stage(ctx));
      const files = await step(3, async () => {
        if (!isInside(this.outputRoot, ctx.outDir)) throw new Error("output directory escapes build/packages");
        await rm(ctx.outDir, { recursive: true, force: true });
        await mkdir(ctx.outDir, { recursive: true });
        return target.package(ctx, app);
      });
      await step(4, async () => {
        for (const file of files) {
          if (!isInside(ctx.outDir, file) || (await stat(file)).size === 0) throw new Error(`artifact ${file} is missing or empty`);
        }
        requirePass(await target.verify(ctx, files), "verification");
      });
      artifacts = await step(5, async () => {
        const list = await Promise.all(
          files.map(async (file) => ({ name: relative(ctx.outDir, file), path: this.relative(file), size: (await stat(file)).size, sha256: await sha256(file) })),
        );
        await writeFile(join(ctx.outDir, "SHA256SUMS"), list.map((a) => `${a.sha256}  ${a.name}\n`).join(""));
        await writeFile(join(ctx.outDir, "INSTALL.md"), target.install(job.version));
        return list;
      });
      job.artifacts = artifacts;
      job.status = "succeeded";
      log(`== succeeded: ${artifacts.map((a) => a.name).join(", ")}`);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.artifacts = [];
      for (const s of job.steps) {
        if (s.status === "running") s.status = "failed";
        else if (s.status === "pending") s.status = "skipped";
      }
      log(`== failed: ${job.error}`);
      log(`work files kept for inspection in ${this.relative(workDir)}`);
    } finally {
      job.finishedAt = this.now().toISOString();
      await pendingLog;
      await this.persist(job);
      if (job.status === "succeeded") {
        await writeFile(join(ctx.outDir, "build.json"), `${JSON.stringify({ ...job, log: [] }, null, 2)}\n`);
        await writeFile(join(ctx.outDir, "build.log"), await readFile(logFile, "utf8").catch(() => ""));
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  private async persist(job: BuildJob): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await writeFile(join(this.jobsDir, `${job.id}.json`), `${JSON.stringify({ ...job, log: [] }, null, 2)}\n`);
  }

  /**
   * Writes RELEASE_NOTES.md and SHA256SUMS for every successful build of `version`, after
   * re-hashing each artifact. Local files only: nothing is uploaded, tagged or published.
   */
  async prepareRelease(version: string): Promise<ReleaseReport> {
    const request = parseRequest({ target: "linux-tarball", version, arch: "noarch" });
    const versionDir = join(this.outputRoot, request.version);
    const builds: BuildJob[] = [];
    for (const id of Object.keys(this.targets)) {
      try {
        const job = BuildJobSchema.parse(JSON.parse(await readFile(join(versionDir, id, "build.json"), "utf8")));
        if (job.status === "succeeded") builds.push(job);
      } catch {
        // not built
      }
    }
    if (builds.length === 0) throw new BuildRequestError(409, `no successful builds of ${version} to release; build a package first`);

    for (const build of builds) {
      for (const artifact of build.artifacts) {
        const actual = await sha256(resolve(REPO_ROOT, artifact.path)).catch(() => null);
        if (actual !== artifact.sha256) throw new BuildRequestError(409, `${artifact.path} changed or disappeared since it was built; rebuild ${build.target}`);
      }
    }

    const sums = builds.flatMap((b) => b.artifacts.map((a) => `${a.sha256}  ${b.target}/${a.name}\n`)).join("");
    const notes = releaseNotes(version, builds, this.targets, this.now());
    await writeFile(join(versionDir, "SHA256SUMS"), sums);
    await writeFile(join(versionDir, "RELEASE_NOTES.md"), notes);
    return {
      version,
      files: [join(versionDir, "RELEASE_NOTES.md"), join(versionDir, "SHA256SUMS")].map((f) => this.relative(f)),
      notes,
      targets: builds.map((b) => b.target),
    };
  }
}

function parseRequest(input: unknown): BuildRequest {
  const result = BuildRequestSchema.safeParse(input);
  if (!result.success) throw new BuildRequestError(400, result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  return result.data;
}

const isInside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** HEAD's commit hash, "-dirty" when the work tree has changes; null outside git. */
async function commitOf(): Promise<string | null> {
  const head = await capture("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, timeoutMs: 10_000 }).catch(() => null);
  if (!head || head.code !== 0) return null;
  const status = await capture("git", ["status", "--porcelain"], { cwd: REPO_ROOT, timeoutMs: 30_000 }).catch(() => null);
  return `${head.stdout.trim()}${status?.stdout.trim() ? "-dirty" : ""}`;
}

const formatSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function releaseNotes(version: string, builds: BuildJob[], targets: Record<BuildTargetId, Target>, now: Date): string {
  const commits = [...new Set(builds.map((b) => b.commit ?? "unknown"))];
  const rows = builds.flatMap((b) =>
    b.artifacts.map((a) => `| ${targets[b.target].platform} | \`${b.target}/${a.name}\` | ${formatSize(a.size)} | \`${a.sha256}\` |`),
  );
  const install = builds.map((b) => targets[b.target].install(version).replace(/^# /m, "### ").replace(/^## /gm, "#### ")).join("\n");
  return `# LatchVerify ${version}

Prepared ${now.toISOString().slice(0, 10)} from commit ${commits.map((c) => `\`${c}\``).join(", ")}.
${commits.some((c) => c.endsWith("-dirty")) ? "\n> **Warning:** at least one package was built from a work tree with uncommitted changes.\n" : ""}
These files are prepared locally. Nothing has been uploaded or published: attach them to a
release yourself when you are ready.

## Packages

| Platform | File | Size | SHA-256 |
|---|---|---|---|
${rows.join("\n")}

Check a download with \`sha256sum -c SHA256SUMS\` in this directory.

## What's changed

<!-- Summarize the changes since the previous release here. -->

## Install

${install}`;
}
