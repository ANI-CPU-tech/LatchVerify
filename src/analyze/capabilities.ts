import type { CapabilitySet, DeclaredAnnotations, Finding, LlmAdvisory, McpTool } from "../schema/index.js";

/** Which capability a parameter name implies when it is an unconstrained string. */
export type SchemaSignal = "filesystem" | "exec" | "network" | "credentials";

/**
 * Pass 1 signal table: parameter names (case-insensitive) and the capability they imply.
 * An enum or const on the param demotes the signal to "constrained". See docs/CAPABILITIES.md.
 */
export const PARAM_SIGNALS: Readonly<Record<SchemaSignal, readonly string[]>> = {
  filesystem: ["path", "file", "filename", "filepath", "dir", "directory", "folder"],
  exec: ["command", "cmd", "script", "shell", "exec", "args"],
  network: ["url", "uri", "endpoint", "host", "webhook"],
  credentials: ["token", "apikey", "api_key", "secret", "password", "env"],
};

/**
 * TODO: return a CapabilitySet with every flag false, every list empty, scope "none" and
 * declared {}. The baseline each pass widens from.
 */
export function emptyCapabilitySet(): CapabilitySet {
  throw new Error("not implemented");
}

/**
 * Pass 1 (primary): deterministic schema signals.
 * TODO: walk inputSchema.properties (recursing into nested objects/arrays), match names against
 * PARAM_SIGNALS, treat params with enum/const/pattern as constrained and bare strings as
 * unconstrained, honour format "uri" as network egress. Returns the derived set with
 * crossServerRefs empty and declared {}.
 */
export function deriveFromSchema(tool: McpTool): CapabilitySet {
  throw new Error("not implemented");
}

/** Pass 2: TODO: copy readOnlyHint / destructiveHint / openWorldHint from tool.annotations as claims. */
export function readDeclared(tool: McpTool): DeclaredAnnotations {
  throw new Error("not implemented");
}

/**
 * TODO: compare declared claims with derived capabilities and return one "annotation_mismatch"
 * finding per contradiction, e.g. readOnlyHint true with filesystem.write or exec.enabled, or
 * openWorldHint false with network.egress.
 */
export function annotationMismatches(capabilities: CapabilitySet): Finding[] {
  throw new Error("not implemented");
}

/**
 * Full extraction: pass 1, then pass 2, then (if supplied) the cached pass-3 advisory.
 * TODO: merge in priority order, never letting the advisory narrow a deterministic signal,
 * and fill crossServerRefs from `knownTools` names found in the description. Returns the
 * capability set and every finding produced along the way.
 */
export function extractCapabilities(
  tool: McpTool,
  knownTools: readonly string[],
  advisory?: LlmAdvisory,
): { capabilities: CapabilitySet; findings: Finding[] } {
  throw new Error("not implemented");
}
