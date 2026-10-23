import { z } from "zod";
import {
  BuildCheckSchema,
  BuildInfoSchema,
  BuildJobSchema,
  BuildTargetSummarySchema,
  ReleaseReportSchema,
  type BuildInfo,
  type BuildJob,
  type BuildRequest,
  type BuildTargetSummary,
  type ReleaseReport,
} from "@schema/index.js";
import { getJson, postJson } from "./api";

/**
 * Client for the development-only build API (scripts/package/routes.ts). `latch review --ui`
 * does not serve it, so fetchBuildInfo() rejects with an ApiError 404 there.
 */

export const fetchBuildInfo = (signal?: AbortSignal): Promise<BuildInfo> => getJson("/api/build/info", BuildInfoSchema, "build info", signal);

export const fetchBuildTargets = (signal?: AbortSignal): Promise<BuildTargetSummary[]> =>
  getJson("/api/build/targets", z.array(BuildTargetSummarySchema), "target list", signal);

const CheckReportSchema = z.object({ checks: z.array(BuildCheckSchema), ready: z.boolean() });
export type CheckReport = z.infer<typeof CheckReportSchema>;

export const checkBuild = (target: string, version: string): Promise<CheckReport> =>
  postJson("/api/build/check", { target, version }, CheckReportSchema, "check report");

export const startBuild = (request: BuildRequest): Promise<BuildJob> => postJson("/api/build/jobs", request, BuildJobSchema, "build");

export const fetchBuildJobs = (signal?: AbortSignal): Promise<BuildJob[]> => getJson("/api/build/jobs", z.array(BuildJobSchema), "build list", signal);

export const fetchBuildJob = (id: string, signal?: AbortSignal): Promise<BuildJob> =>
  getJson(`/api/build/jobs/${encodeURIComponent(id)}`, BuildJobSchema, "build", signal);

export const prepareRelease = (version: string): Promise<ReleaseReport> => postJson("/api/build/release", { version }, ReleaseReportSchema, "release report");

/** Download URL of an artifact of a successful build. */
export const artifactUrl = (jobId: string, name: string): string =>
  `/api/build/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
