import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../scripts/package/config.js";
import { mountBuildRoutes } from "../../scripts/package/routes.js";
import { BuildRequestError, BuildService } from "../../scripts/package/runner.js";
import { TARGETS, type Target } from "../../scripts/package/targets.js";
import { BuildJobSchema, type BuildCheck } from "../../src/schema/index.js";
import { CLIENT_HEADER, createRoutes } from "../../src/ui/routes.js";

let dir: string;

/** A target that runs nothing external: it writes one file and reports scripted checks. */
function fakeTarget(overrides: Partial<Target> = {}): Target {
  const ok: BuildCheck[] = [{ name: "tool", status: "pass", detail: "found" }];
  return {
    ...TARGETS["linux-tarball"],
    prerequisites: async () => ok,
    validate: async () => ok,
    async package(ctx) {
      const file = join(ctx.outDir, `fake-${ctx.version}.tar.gz`);
      await writeFile(file, "package bytes");
      ctx.log("packaged");
      return [file];
    },
    verify: async () => ok,
    ...overrides,
  };
}

function service(target: Target = fakeTarget()) {
  return new BuildService({
    outputRoot: join(dir, "packages"),
    targets: { ...TARGETS, "linux-tarball": target },
    stage: async (ctx) => {
      await mkdir(join(ctx.workDir, "app"), { recursive: true });
      return join(ctx.workDir, "app");
    },
  });
}

async function finished(svc: BuildService, version = "1.0.0") {
  const { id } = svc.start({ target: "linux-tarball", version, arch: "noarch" });
  await svc.idle();
  return svc.job(id);
}

beforeEach(async () => {
  // Inside the repository (artifact paths are recorded relative to it), under gitignored build/.
  await mkdir(join(REPO_ROOT, "build"), { recursive: true });
  dir = await mkdtemp(join(REPO_ROOT, "build", "test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("BuildService", () => {
  it("records a verified build with its artifacts, checksums, install notes and log", async () => {
    const svc = service();
    const job = await finished(svc);
    expect(BuildJobSchema.parse(job)).toEqual(job);
    expect(job.status).toBe("succeeded");
    expect(job.steps.every((s) => s.status === "passed")).toBe(true);
    expect(job.artifacts).toEqual([
      expect.objectContaining({ name: "fake-1.0.0.tar.gz", size: 13, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    const out = join(dir, "packages", "1.0.0", "linux-tarball");
    expect(await readFile(join(out, "SHA256SUMS"), "utf8")).toBe(`${job.artifacts[0]!.sha256}  fake-1.0.0.tar.gz\n`);
    expect(await readFile(join(out, "INSTALL.md"), "utf8")).toContain("## Uninstall");
    expect(await readFile(join(out, "build.log"), "utf8")).toContain("packaged");
    expect(job.log).toContain("packaged");
    expect(existsSync(join(dir, "packages", ".work", job.id))).toBe(false);
    expect(await svc.artifactFile(job.id, "fake-1.0.0.tar.gz")).toBe(join(out, "fake-1.0.0.tar.gz"));
  });

  it("never reports success, or offers artifacts, when verification fails", async () => {
    const job = await finished(service(fakeTarget({ verify: async () => [{ name: "contents", status: "fail", detail: "missing bin/latch" }] })));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("verification failed: contents");
    expect(job.artifacts).toEqual([]);
    expect(job.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "failed", "skipped"]);
  });

  it("stops before building when a prerequisite is missing", async () => {
    let built = false;
    const svc = new BuildService({
      outputRoot: join(dir, "packages"),
      targets: { ...TARGETS, "linux-tarball": fakeTarget({ prerequisites: async () => [{ name: "makepkg", status: "fail", detail: "not found" }] }) },
      stage: async () => {
        built = true;
        return dir;
      },
    });
    const job = await finished(svc);
    expect(job.status).toBe("failed");
    expect(built).toBe(false);
    expect(job.steps.map((s) => s.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
  });

  it("records a thrown packaging error as a failure", async () => {
    const job = await finished(service(fakeTarget({ package: async () => Promise.reject(new Error("makepkg exited with status 4")) })));
    expect(job).toMatchObject({ status: "failed", error: "makepkg exited with status 4", artifacts: [] });
  });

  it("refuses invalid requests and unknown jobs", async () => {
    const svc = service();
    for (const bad of [{ target: "rm -rf", version: "1.0.0", arch: "noarch" }, { target: "arch", version: "1.0.0;id", arch: "noarch" }, null]) {
      expect(() => svc.start(bad)).toThrow(BuildRequestError);
    }
    await expect(svc.job("../../etc/passwd")).rejects.toMatchObject({ status: 404 });
    const job = await finished(svc);
    await expect(svc.artifactFile(job.id, "../../../package.json")).rejects.toMatchObject({ status: 404 });
    await expect(svc.artifactFile(job.id, "SHA256SUMS")).rejects.toMatchObject({ status: 404 });
  });

  it("runs builds one at a time and lists them newest first", async () => {
    const svc = service();
    const a = svc.start({ target: "linux-tarball", version: "1.0.0", arch: "noarch" });
    const b = svc.start({ target: "linux-tarball", version: "1.0.1", arch: "noarch" });
    expect(b.status).toBe("queued");
    await svc.idle();
    const ids = (await svc.listJobs()).map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    // A fresh service (a restarted server) still lists them from disk.
    expect((await service().listJobs()).map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect((await service().job(a.id)).log).toContain("packaged");
  });

  it("reports a build the server never finished as interrupted", async () => {
    const jobs = join(dir, "packages", ".jobs");
    await mkdir(jobs, { recursive: true });
    const record = {
      id: "abc123-0a1b2c",
      target: "arch",
      version: "1.0.0",
      arch: "noarch",
      status: "running",
      createdAt: "2026-10-23T10:00:00.000Z",
      startedAt: "2026-10-23T10:00:00.000Z",
      finishedAt: null,
      commit: null,
      steps: [],
      checks: [],
      artifacts: [],
      outputDir: "build/packages/1.0.0/arch",
      error: null,
      log: [],
    };
    await writeFile(join(jobs, `${record.id}.json`), JSON.stringify(record));
    expect(await service().job(record.id)).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted") });
  });

  it("prepares release notes and checksums from successful builds only, re-hashing each file", async () => {
    const svc = service();
    await expect(svc.prepareRelease("1.0.0")).rejects.toMatchObject({ status: 409 });
    const job = await finished(svc);
    const report = await svc.prepareRelease("1.0.0");
    expect(report.targets).toEqual(["linux-tarball"]);
    expect(report.notes).toContain(job.artifacts[0]!.sha256);
    expect(report.notes).toContain("Nothing has been uploaded or published");
    expect(await readFile(join(dir, "packages", "1.0.0", "SHA256SUMS"), "utf8")).toBe(`${job.artifacts[0]!.sha256}  linux-tarball/fake-1.0.0.tar.gz\n`);

    await writeFile(resolve(REPO_ROOT, job.artifacts[0]!.path), "tampered");
    await expect(svc.prepareRelease("1.0.0")).rejects.toThrow("changed or disappeared");
  });
});

describe("build API", () => {
  const app = (svc: BuildService) => {
    const routes = createRoutes({ lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), reviewer: "alice@example.com" });
    mountBuildRoutes(routes, svc);
    return routes;
  };
  const post = (body: unknown, headers: Record<string, string> = { [CLIENT_HEADER]: "test" }) =>
    ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) satisfies RequestInit;

  it("is not served by the review API on its own (latch review --ui)", async () => {
    const plain = new Hono().route("/", createRoutes({ lockfilePath: join(dir, "l"), stateDir: dir, reviewer: "r" }));
    for (const path of ["/api/build/info", "/api/build/targets", "/api/build/jobs"]) expect((await plain.request(path)).status).toBe(404);
  });

  it("requires the client header for every write", async () => {
    const api = app(service());
    expect((await api.request("/api/build/jobs", post({ target: "linux-tarball", version: "1.0.0", arch: "noarch" }, {}))).status).toBe(403);
    expect((await api.request("/api/build/release", post({ version: "1.0.0" }, {}))).status).toBe(403);
  });

  it("rejects bad parameters with 400 and queues a valid build with 202", async () => {
    const svc = service();
    const api = app(svc);
    const bad = await api.request("/api/build/jobs", post({ target: "linux-tarball", version: "1.0.0", arch: "noarch", script: "curl x | sh" }));
    expect(bad.status).toBe(400);
    const ok = await api.request("/api/build/jobs", post({ target: "linux-tarball", version: "1.0.0", arch: "noarch" }));
    expect(ok.status).toBe(202);
    const { id } = (await ok.json()) as { id: string };
    await svc.idle();
    const job = (await (await api.request(`/api/build/jobs/${id}`)).json()) as { status: string; artifacts: Array<{ name: string }> };
    expect(job.status).toBe("succeeded");

    const download = await api.request(`/api/build/jobs/${id}/artifacts/${job.artifacts[0]!.name}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="fake-1.0.0.tar.gz"');
    expect(await download.text()).toBe("package bytes");
    expect((await api.request(`/api/build/jobs/${id}/artifacts/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await api.request("/api/build/jobs/nope")).status).toBe(404);
  });

  it("reports the project version and output directory", async () => {
    const info = (await (await app(service()).request("/api/build/info")).json()) as Record<string, string>;
    expect(info.projectVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.outputRoot).toMatch(/^build\/test-.*\/packages$/);
  });
});
