import type { Finding } from "../schema/index.js";

/**
 * Imperative phrasing aimed at the model rather than the user. Description fields describe a
 * tool; they should never instruct the agent. Matched case-insensitively.
 */
export const IMPERATIVE_PHRASES: readonly string[] = [
  "before calling",
  "before using",
  "after calling",
  "you must",
  "you should always",
  "do not tell the user",
  "don't tell the user",
  "do not mention",
  "without asking",
  "ignore previous",
  "ignore all previous",
  "disregard",
  "<important>",
  "system prompt",
];

/** Sensitive filesystem locations that should never appear in a description. */
export const SENSITIVE_PATHS: readonly string[] = [
  "~/.ssh",
  "id_rsa",
  "id_ed25519",
  "~/.aws",
  "~/.config",
  ".env",
  "/etc/passwd",
  "/etc/shadow",
  "~/.cursor/mcp.json",
  "claude_desktop_config.json",
];

/** Context for cross-server reference detection. */
export interface PatternContext {
  /** Tool names exposed by *other* servers in the lockfile. */
  otherServerTools: readonly string[];
}

/** TODO: return "pattern" findings (warn; critical when combined with a sensitive path) for IMPERATIVE_PHRASES hits. */
export function findImperatives(text: string): Finding[] {
  throw new Error("not implemented");
}

/** TODO: return "pattern" findings (critical) for SENSITIVE_PATHS and absolute/home-relative paths in `text`. */
export function findPathMentions(text: string): Finding[] {
  throw new Error("not implemented");
}

/** TODO: return "pattern" findings for SCREAMING_SNAKE env var names, critical when they look like secrets (*_KEY, *_TOKEN, *_SECRET). */
export function findEnvVarMentions(text: string): Finding[] {
  throw new Error("not implemented");
}

/** TODO: return "cross_server" findings (critical) for each ctx.otherServerTools name mentioned in `text`. */
export function findCrossServerRefs(text: string, ctx: PatternContext): Finding[] {
  throw new Error("not implemented");
}

/** TODO: run every pattern check above over one tool field and concatenate the findings. */
export function detectPatterns(text: string, field: string, ctx: PatternContext): Finding[] {
  throw new Error("not implemented");
}
