import { z } from "zod";

/**
 * Filesystem reach of a tool. `scope` is the key widening signal:
 * an unconstrained `path` param is wider than an enum-constrained one.
 */
export const FilesystemCapabilitySchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  scope: z.enum(["none", "constrained", "unconstrained"]),
  /** Concrete paths or globs the tool is limited to, when constrained. */
  paths: z.array(z.string()),
});
export type FilesystemCapability = z.infer<typeof FilesystemCapabilitySchema>;

export const ExecCapabilitySchema = z.object({
  enabled: z.boolean(),
  /** True when input is passed to a shell rather than an argv array. */
  shell: z.boolean(),
});
export type ExecCapability = z.infer<typeof ExecCapabilitySchema>;

export const NetworkCapabilitySchema = z.object({
  egress: z.boolean(),
  /** Allow-listed hosts, when the tool's schema constrains them. */
  domains: z.array(z.string()),
  /** True when the tool accepts an arbitrary URL/endpoint. */
  unconstrained: z.boolean(),
});
export type NetworkCapability = z.infer<typeof NetworkCapabilitySchema>;

export const CredentialsCapabilitySchema = z.object({
  readsEnv: z.boolean(),
  readsSecrets: z.boolean(),
});
export type CredentialsCapability = z.infer<typeof CredentialsCapabilitySchema>;

/**
 * Server-supplied MCP annotations. Stored as *claims*, never facts:
 * a mismatch with the derived capability set is itself a finding.
 */
export const DeclaredAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type DeclaredAnnotations = z.infer<typeof DeclaredAnnotationsSchema>;

/** Structured capability set derived from one tool definition. Diffed instead of text. */
export const CapabilitySetSchema = z.object({
  filesystem: FilesystemCapabilitySchema,
  exec: ExecCapabilitySchema,
  network: NetworkCapabilitySchema,
  credentials: CredentialsCapabilitySchema,
  /** Names of tools on *other* servers referenced from this tool's text. */
  crossServerRefs: z.array(z.string()),
  declared: DeclaredAnnotationsSchema,
});
export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;

export const FindingTypeSchema = z.enum([
  "unicode",
  "pattern",
  "cross_server",
  "capability_gain",
  "annotation_mismatch",
]);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const SeveritySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** One detector or differ result attached to a pending change. */
export const FindingSchema = z.object({
  type: FindingTypeSchema,
  severity: SeveritySchema,
  message: z.string().min(1),
  /** The offending substring, codepoints, or schema path that triggered it. */
  evidence: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;
