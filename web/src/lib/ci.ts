/**
 * `latch verify` exit codes (src/commands/verify.ts VERIFY_EXIT, documented in docs/LOCKFILE.md),
 * copied so the browser bundle does not import CLI code. tests/web/ci.test.ts keeps them equal.
 */
export const VERIFY_EXIT_CODES = [
  { code: 0, status: "ok", meaning: "Every live tool matches its pin, or differs only at tier 0/1" },
  { code: 1, status: "drift", meaning: "At least one tier-2 change, or a tool that is not pinned" },
  { code: 2, status: "hard_block", meaning: "At least one tier-3 change" },
  { code: 3, status: "error", meaning: "A server failed to start or returned invalid JSON-RPC" },
] as const;

/** The GitHub Actions steps from docs/LOCKFILE.md. */
export const CI_SNIPPET = `- run: pnpm install --frozen-lockfile
- run: pnpm exec latch verify`;
