// `pnpm demo:add`: add a demo server to an MCP client in one step, or remove it again.
//
//   pnpm demo:add                                  list the presets and where each is installed
//   pnpm demo:add <preset> [--client <id>]         add it (default client: claude-code)
//   pnpm demo:add <preset> --remove [--client <id>]  remove it (from every client without --client)
//
// Presets live in src/dev/presets.ts; the Dev Tools page (LATCH_DEV=1) does the same. They go into
// the per-user latch.lock unless LATCH_LOCKFILE_PATH names another, and are pinned on first run.
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { SUPPORTED_CLIENTS, type ClientId } from "../src/config/clients.js";
import { userLockfilePath } from "../src/config/paths.js";
import { DEMO_PRESETS, addPreset, findPreset, presetStates, removePreset } from "../src/dev/presets.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { client: { type: "string" }, remove: { type: "boolean", default: false } } });
const lockfilePath = process.env.LATCH_LOCKFILE_PATH?.trim() || userLockfilePath();
const paths = { lockfilePath, stateDir: process.env.LATCH_STATE_DIR?.trim() || join(dirname(lockfilePath), ".latch") };

if (positionals.length === 0) {
  for (const state of await presetStates(lockfilePath)) {
    console.log(`${state.id.padEnd(15)} ${state.name.padEnd(18)} ${state.clients.length > 0 ? `in ${state.clients.join(", ")}` : "not added"}`);
    console.log(`${" ".repeat(16)}${state.description}`);
  }
  process.exit(0);
}
const preset = findPreset(positionals[0]!);
if (preset === undefined) {
  console.error(`no preset "${positionals[0]}"; choose one of ${DEMO_PRESETS.map((p) => p.id).join(", ")}`);
  process.exit(2);
}
if (values.client !== undefined && !(SUPPORTED_CLIENTS as readonly string[]).includes(values.client)) {
  console.error(`--client must be one of ${SUPPORTED_CLIENTS.join(", ")}`);
  process.exit(2);
}
const client = values.client as ClientId | undefined;
if (values.remove) {
  const removed = await removePreset(preset, client, paths);
  console.log(`removed ${preset.id} from ${removed.clients.join(", ") || "no client"}${removed.lockfile ? ` and from ${lockfilePath}` : ""}`);
} else {
  process.exitCode = await addPreset(preset, client ?? "claude-code", paths, process.stdout);
}
