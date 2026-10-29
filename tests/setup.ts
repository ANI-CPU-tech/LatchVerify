import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every lockfile write records its integrity under the per-user application data directory.
// Point that at a throwaway directory so tests never touch the real one. Child processes the
// tests start inherit it.
process.env.LATCH_INTEGRITY_DIR ??= mkdtempSync(join(tmpdir(), "latch-integrity-"));
