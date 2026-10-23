import { z } from "zod";

/**
 * Contract of the development-only build API (/api/build/*, scripts/package/routes.ts) and the
 * Build & Distribution page. The shipped CLI never serves these routes.
 */

export const BuildTargetIdSchema = z.enum(["linux-tarball", "windows-zip", "windows-installer", "arch", "deb", "flatpak"]);
export type BuildTargetId = z.infer<typeof BuildTargetIdSchema>;

/** One prerequisite, validation or verification result. "skip": an optional validator is not installed. */
export const BuildCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skip"]),
  detail: z.string(),
});
export type BuildCheck = z.infer<typeof BuildCheckSchema>;

export const BuildTargetSummarySchema = z.object({
  id: BuildTargetIdSchema,
  label: z.string(),
  platform: z.string(),
  format: z.string(),
  arch: z.literal("noarch"),
  archLabel: z.string(),
  description: z.string(),
  /** True when every prerequisite passes on this machine. */
  available: z.boolean(),
  prerequisites: z.array(BuildCheckSchema),
});
export type BuildTargetSummary = z.infer<typeof BuildTargetSummarySchema>;

/** MAJOR.MINOR.PATCH with an optional dot-separated pre-release (scripts/package/config.ts). */
export const BuildVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4}))?$/, "version must look like 1.2.3 or 1.2.3-rc.1");

export const BuildRequestSchema = z.strictObject({
  target: BuildTargetIdSchema,
  version: BuildVersionSchema,
  arch: z.literal("noarch"),
});
export type BuildRequest = z.infer<typeof BuildRequestSchema>;

export const BuildArtifactSchema = z.object({
  name: z.string(),
  /** Path relative to the repository root. */
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;

export const BuildStepSchema = z.object({
  name: z.string(),
  status: z.enum(["pending", "running", "passed", "failed", "skipped"]),
});

export const BuildJobSchema = z.object({
  id: z.string(),
  target: BuildTargetIdSchema,
  version: BuildVersionSchema,
  arch: z.literal("noarch"),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** HEAD commit the build ran on, with "-dirty" when the work tree had changes. */
  commit: z.string().nullable(),
  steps: z.array(BuildStepSchema),
  checks: z.array(BuildCheckSchema),
  /** Only set when the build succeeded and every verification passed. */
  artifacts: z.array(BuildArtifactSchema),
  /** Output directory relative to the repository root. */
  outputDir: z.string(),
  error: z.string().nullable(),
  /** The newest log lines; the full log is build.log in outputDir. */
  log: z.array(z.string()),
});
export type BuildJob = z.infer<typeof BuildJobSchema>;

export const ReleaseRequestSchema = z.strictObject({ version: BuildVersionSchema });

export const ReleaseReportSchema = z.object({
  version: z.string(),
  /** Files written, relative to the repository root. */
  files: z.array(z.string()),
  notes: z.string(),
  targets: z.array(BuildTargetIdSchema),
});
export type ReleaseReport = z.infer<typeof ReleaseReportSchema>;

export const BuildInfoSchema = z.object({
  projectVersion: z.string(),
  outputRoot: z.string(),
  host: z.string(),
});
export type BuildInfo = z.infer<typeof BuildInfoSchema>;
