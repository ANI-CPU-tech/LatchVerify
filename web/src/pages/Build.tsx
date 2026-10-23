import { BuildVersionSchema, type BuildCheck, type BuildJob, type BuildTargetSummary, type ReleaseReport } from "@schema/index.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, Terminal, buttonClass, inputClass } from "../components/ui";
import { ApiError } from "../lib/api";
import {
  artifactUrl,
  checkBuild,
  fetchBuildInfo,
  fetchBuildJob,
  fetchBuildJobs,
  fetchBuildTargets,
  prepareRelease,
  startBuild,
  type CheckReport,
} from "../lib/buildApi";
import { describeError } from "../lib/data";
import { dateTime, relativeTime, type Tone } from "../lib/format";
import { href } from "../lib/router";
import { navigate } from "../lib/useRoute";
import type { BuildInfo } from "@schema/index.js";

const CHECK_TONE: Record<BuildCheck["status"], Tone> = { pass: "success", fail: "destructive", skip: "neutral" };
const JOB_TONE: Record<BuildJob["status"], Tone> = { queued: "neutral", running: "info", succeeded: "success", failed: "destructive" };
const STEP_TONE = { pending: "neutral", running: "info", passed: "success", failed: "destructive", skipped: "neutral" } as const;

/** How often a running build is polled. */
const POLL_MS = 1000;

function Step({ n, title, children, action }: { n: number; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Panel
      title={
        <>
          <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-primary font-mono text-xs text-primary-foreground">{n}</span>
          {title}
        </>
      }
      action={action}
    >
      {children}
    </Panel>
  );
}

function CheckList({ checks }: { checks: BuildCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {checks.map((check, i) => (
        <li key={`${check.name}-${i}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
          <Badge tone={CHECK_TONE[check.status]} className="w-12 justify-center uppercase">
            {check.status}
          </Badge>
          <span className="font-medium">{check.name}</span>
          <span className="min-w-0 flex-1 basis-60 break-words font-mono text-xs text-muted-foreground">{check.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * Build & Distribution: pick a target, set the version, check prerequisites, run a real build,
 * follow its log, download verified packages and prepare release notes. Every action calls the
 * development build API; the page never claims a result the API did not report.
 */
export function Build({ jobId }: { jobId: string | null }) {
  const [info, setInfo] = useState<{ status: "loading" } | { status: "ready"; info: BuildInfo } | { status: "error"; error: unknown }>({ status: "loading" });
  const [targets, setTargets] = useState<BuildTargetSummary[] | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [check, setCheck] = useState<{ busy: boolean; report: CheckReport | null; error: string | null }>({ busy: false, report: null, error: null });
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [release, setRelease] = useState<{ busy: boolean; report: ReleaseReport | null; error: string | null }>({ busy: false, report: null, error: null });
  const logRef = useRef<HTMLDivElement>(null);

  const loadTargets = useCallback(() => {
    setTargets(null);
    fetchBuildTargets().then(setTargets, (error: unknown) => setInfo({ status: "error", error }));
  }, []);
  const loadJobs = useCallback(() => fetchBuildJobs().then(setJobs, () => undefined), []);

  useEffect(() => {
    fetchBuildInfo().then(
      (data) => {
        setInfo({ status: "ready", info: data });
        setVersion((current) => current || data.projectVersion);
        loadTargets();
        void loadJobs();
      },
      (error: unknown) => setInfo({ status: "error", error }),
    );
  }, [loadTargets, loadJobs]);

  // The build in the URL (#/build/<id>): opened from Recent builds, or just started.
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    fetchBuildJob(jobId, controller.signal).then((opened) => {
      setJob(opened);
      // Steps 1–3 and 8 then describe the build on screen.
      setTargetId(opened.target);
      setVersion(opened.version);
    }, (error: unknown) => {
      if (!controller.signal.aborted) setStartError(describeError(error));
    });
    return () => controller.abort();
  }, [jobId]);

  // Follow the selected build while it is queued or running.
  const activeId = job && (job.status === "queued" || job.status === "running") ? job.id : null;
  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => {
      fetchBuildJob(activeId).then((next) => {
        setJob(next);
        if (next.status === "succeeded" || next.status === "failed") void loadJobs();
      }, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, loadJobs]);

  useEffect(() => {
    logRef.current?.querySelector("pre")?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
  }, [job?.log.length]);

  if (info.status === "loading") return <LoadingState label="Loading build tools..." />;
  if (info.status === "error") {
    const devOnly = info.error instanceof ApiError && info.error.status === 404;
    return (
      <>
        <PageHeader title="Build & Distribution" />
        {devOnly ? (
          <Panel>
            <EmptyState title="Available from a source checkout">
              Packaging runs through the development server. In the LatchVerify repository, run <code className="font-mono">pnpm ui</code>{" "}
              and open this page there, or use <code className="font-mono">pnpm package --list</code> in a terminal.
            </EmptyState>
          </Panel>
        ) : (
          <ErrorState title="The build API could not be reached." error={info.error} />
        )}
      </>
    );
  }

  const target = targets?.find((t) => t.id === targetId) ?? null;
  const versionValid = BuildVersionSchema.safeParse(version).success;
  const running = jobs.some((j) => j.status === "queued" || j.status === "running") || activeId !== null;
  const canBuild = target !== null && target.available && versionValid && !running;

  const runChecks = async () => {
    if (!target) return;
    setCheck({ busy: true, report: null, error: null });
    try {
      setCheck({ busy: false, report: await checkBuild(target.id, version), error: null });
    } catch (error) {
      setCheck({ busy: false, report: null, error: describeError(error) });
    }
  };

  const build = async (request = target && { target: target.id, version, arch: "noarch" as const }) => {
    if (!request) return;
    setStartError(null);
    setRelease({ busy: false, report: null, error: null });
    try {
      const started = await startBuild(request);
      setJob(started);
      navigate({ page: "build", job: started.id });
      void loadJobs();
    } catch (error) {
      setStartError(describeError(error));
    }
  };

  const prepare = async (forVersion: string) => {
    setRelease({ busy: true, report: null, error: null });
    try {
      setRelease({ busy: false, report: await prepareRelease(forVersion), error: null });
    } catch (error) {
      setRelease({ busy: false, report: null, error: describeError(error) });
    }
  };

  return (
    <>
      <PageHeader
        title="Build & Distribution"
        description={
          <>
            Package LatchVerify for Windows and Linux on this machine ({info.info.host}). Packages go to{" "}
            <code className="font-mono">{info.info.outputRoot}/</code>. Nothing is uploaded or published.
          </>
        }
        actions={
          <button type="button" onClick={loadTargets} className={buttonClass("secondary", "sm")}>
            Recheck tools
          </button>
        }
      />

      <Step n={1} title="Platform and package format">
        {!targets ? (
          <LoadingState label="Checking build tools..." />
        ) : (
          <fieldset>
            <legend className="sr-only">Package format</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {targets.map((t) => {
                const missing = t.prerequisites.filter((c) => c.status === "fail").length;
                const checked = t.id === targetId;
                return (
                  <label
                    key={t.id}
                    className={`cursor-pointer rounded-md border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
                      checked ? "border-primary bg-primary/5" : "hover:border-input"
                    }`}
                  >
                    <input
                      type="radio"
                      name="target"
                      value={t.id}
                      checked={checked}
                      onChange={() => {
                        setTargetId(t.id);
                        setCheck({ busy: false, report: null, error: null });
                      }}
                      className="sr-only"
                    />
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold">{t.label}</span>
                      <Badge tone={t.available ? "success" : "warning"}>{t.available ? "Ready" : `${missing} missing`}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t.platform} · <span className="font-mono">{t.format}</span>
                    </span>
                    <span className="mt-2 block text-xs">{t.description}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
      </Step>

      <Step n={2} title="Version and architecture">
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <label htmlFor="build-version" className="block text-xs font-medium text-muted-foreground">
              Version
            </label>
            <input
              id="build-version"
              className={`${inputClass} w-40 font-mono`}
              value={version}
              onChange={(event) => setVersion(event.target.value.trim())}
              aria-invalid={!versionValid}
              aria-describedby="build-version-help"
            />
            <p id="build-version-help" className={`text-xs ${versionValid ? "text-muted-foreground" : "text-destructive"}`}>
              {versionValid ? `package.json is ${info.info.projectVersion}` : "Use 1.2.3 or 1.2.3-rc.1"}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="build-arch" className="block text-xs font-medium text-muted-foreground">
              Architecture
            </label>
            <select id="build-arch" className={inputClass} value="noarch" disabled={!target}>
              <option value="noarch">{target ? target.archLabel : "Choose a format first"}</option>
            </select>
            <p className="text-xs text-muted-foreground">LatchVerify is pure JavaScript: one package runs on every CPU architecture.</p>
          </div>
        </div>
      </Step>

      <Step
        n={3}
        title="Prerequisites and configuration"
        action={
          <button type="button" onClick={runChecks} disabled={!target || !versionValid || check.busy} className={buttonClass("secondary", "sm")}>
            {check.busy ? "Checking..." : "Run checks"}
          </button>
        }
      >
        {!target ? (
          <p className="text-sm text-muted-foreground">Choose a package format to see what it needs.</p>
        ) : (
          <div className="space-y-3">
            {check.report ? (
              <p className={`text-sm font-medium ${check.report.ready ? "text-success" : "text-destructive"}`}>
                {check.report.ready ? "Ready to build." : "Not ready: fix the failed checks below."}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Tools found on this machine. Run checks to also validate the packaging files.</p>
            )}
            {check.error && <ErrorState title="The checks could not run." error={check.error} />}
            <CheckList checks={check.report?.checks ?? target.prerequisites} />
          </div>
        )}
      </Step>

      <Step n={4} title="Build">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void build()} disabled={!canBuild} className={buttonClass("primary")}>
            Start build
          </button>
          <p className="text-sm text-muted-foreground">
            {running
              ? "A build is running; builds run one at a time."
              : !target
                ? "Choose a package format."
                : !target.available
                  ? `${target.label} cannot be built here: install what step 3 lists.`
                  : !versionValid
                    ? "Enter a valid version."
                    : `Builds ${target.label} ${version} with pnpm run build, then packages and verifies it.`}
          </p>
        </div>
        {startError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {startError}
          </p>
        )}
      </Step>

      {job && (
        <Step
          n={5}
          title={`${job.target} ${job.version}`}
          action={<Badge tone={JOB_TONE[job.status]}>{job.status}</Badge>}
        >
          <div className="space-y-4">
            <ol className="flex flex-wrap gap-2" aria-label="Build steps">
              {job.steps.map((s) => (
                <li key={s.name}>
                  <Badge tone={STEP_TONE[s.status]}>
                    {s.name}: {s.status}
                  </Badge>
                </li>
              ))}
            </ol>
            {job.error && (
              <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {job.error}
              </p>
            )}
            <div ref={logRef} aria-live="off">
              <Terminal label="Build log">{job.log.length > 0 ? job.log.join("\n") : job.status === "queued" ? "Waiting to start..." : "No log lines."}</Terminal>
            </div>
            <p className="text-xs text-muted-foreground">
              Full log and record: <code className="font-mono">{info.info.outputRoot}/.jobs/{job.id}.log</code>
            </p>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">6. Checks and verification</h3>
              {job.checks.length > 0 ? <CheckList checks={job.checks} /> : <p className="text-sm text-muted-foreground">No checks yet.</p>}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">7. Packages</h3>
              {job.status === "succeeded" ? (
                <>
                  <ul className="divide-y rounded-md border text-sm">
                    {job.artifacts.map((artifact) => (
                      <li key={artifact.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                        <a href={artifactUrl(job.id, artifact.name)} download className="break-all font-mono text-primary hover:underline">
                          {artifact.name}
                        </a>
                        <span className="text-xs text-muted-foreground">{formatSize(artifact.size)}</span>
                        <code className="basis-full break-all font-mono text-xs text-muted-foreground">sha256 {artifact.sha256}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    Saved in <code className="font-mono">{job.outputDir}/</code> with SHA256SUMS, INSTALL.md and build.json.
                  </p>
                </>
              ) : job.status === "failed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted-foreground">No packages: the build failed, so nothing is offered for download.</p>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => void build({ target: job.target, version: job.version, arch: job.arch })}
                    className={buttonClass("secondary", "sm")}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Packages appear here once the build succeeds.</p>
              )}
            </section>
          </div>
        </Step>
      )}

      <Step
        n={8}
        title="Release preparation"
        action={
          <button type="button" onClick={() => void prepare(version)} disabled={!versionValid || release.busy} className={buttonClass("secondary", "sm")}>
            {release.busy ? "Preparing..." : `Prepare ${versionValid ? version : "release"}`}
          </button>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Writes RELEASE_NOTES.md (packages, checksums, install steps) and SHA256SUMS for every successful build of this version,
            after re-hashing each file. Publishing stays a separate, manual step.
          </p>
          {release.error && <ErrorState title="Release notes were not written." error={release.error} />}
          {release.report && (
            <>
              <p className="text-success">
                Wrote {release.report.files.map((f) => f.split("/").pop()).join(" and ")} for {release.report.targets.join(", ")}.
              </p>
              <Terminal label="Release notes">{release.report.notes}</Terminal>
            </>
          )}
        </div>
      </Step>

      <Panel title="Recent builds" bodyClassName="">
        {jobs.length === 0 ? (
          <EmptyState title="No builds yet" />
        ) : (
          <ul className="divide-y">
            {jobs.slice(0, 15).map((j) => (
              <li key={j.id}>
                <a
                  href={href({ page: "build", job: j.id })}
                  aria-current={j.id === job?.id ? "true" : undefined}
                  className={`flex flex-wrap items-center gap-3 px-4 py-2 text-sm hover:bg-muted/50 ${j.id === job?.id ? "bg-primary/5" : ""}`}
                >
                  <Badge tone={JOB_TONE[j.status]}>{j.status}</Badge>
                  <span className="min-w-0 flex-1 font-mono">
                    {j.target} {j.version}
                  </span>
                  <time dateTime={j.createdAt} title={dateTime(j.createdAt)} className="text-xs text-muted-foreground">
                    {relativeTime(j.createdAt)}
                  </time>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
