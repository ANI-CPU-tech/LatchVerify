/**
 * `latch verify` exit codes, the CI contract (docs/LOCKFILE.md). In a module of their own so
 * cli.ts can name the error code without loading verify and everything it imports.
 */
export const VERIFY_EXIT = {
  ok: 0,
  drift: 1,
  hardBlock: 2,
  error: 3,
} as const;
