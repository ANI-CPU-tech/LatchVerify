import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { ReleaseRequestSchema } from "../../src/schema/index.js";
import { REPO_ROOT, projectVersion } from "./config.js";
import { BuildRequestError, BuildService } from "./runner.js";

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BuildRequestError(400, "request body must be JSON");
  }
}

function fail(c: Context, error: unknown) {
  if (error instanceof BuildRequestError) return c.json({ error: error.message }, error.status);
  throw error;
}

/**
 * Mounts the build API on the review API's app, behind its request guard (loopback host only;
 * writes need X-Latch-Client and a loopback Origin). Only the development server (`pnpm ui`)
 * calls this; `latch review --ui` never serves these routes.
 *
 *   GET  /api/build/info                     project version, output directory, host
 *   GET  /api/build/targets                  targets with prerequisites checked here
 *   POST /api/build/check   {target,version} prerequisites + configuration validation
 *   POST /api/build/jobs    {target,version,arch}  queue a build (202)
 *   GET  /api/build/jobs                     builds, newest first
 *   GET  /api/build/jobs/:id                 one build with its recent log
 *   GET  /api/build/jobs/:id/artifacts/:name download an artifact of a successful build
 *   POST /api/build/release {version}        write release notes and checksums (local only)
 */
export function mountBuildRoutes(app: Hono, service = new BuildService()): void {
  app.get("/api/build/info", async (c) =>
    c.json({ projectVersion: await projectVersion(), outputRoot: relative(REPO_ROOT, service.outputRoot), host: `${process.platform}-${process.arch}` }),
  );

  app.get("/api/build/targets", async (c) => c.json(await service.listTargets()));

  app.post("/api/build/check", async (c) => {
    try {
      const { target, version } = (await body(c)) as { target?: unknown; version?: unknown };
      return c.json(await service.check(String(target), String(version)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/build/jobs", async (c) => {
    try {
      return c.json(service.start(await body(c)), 202);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/api/build/jobs", async (c) => c.json(await service.listJobs()));

  app.get("/api/build/jobs/:id", async (c) => {
    try {
      return c.json(await service.job(c.req.param("id")));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/api/build/jobs/:id/artifacts/:name", async (c) => {
    try {
      const path = await service.artifactFile(c.req.param("id"), c.req.param("name"));
      const { size } = await stat(path);
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="${basename(path).replace(/["\\\r\n]/g, "_")}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/build/release", async (c) => {
    try {
      const parsed = ReleaseRequestSchema.safeParse(await body(c));
      if (!parsed.success) throw new BuildRequestError(400, "version must look like 1.2.3 or 1.2.3-rc.1");
      return c.json(await service.prepareRelease(parsed.data.version));
    } catch (error) {
      return fail(c, error);
    }
  });
}
