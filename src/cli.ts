#!/usr/bin/env node
import { Command, Option } from "commander";
import pc from "picocolors";
import { SUPPORTED_CLIENTS } from "./config/clients.js";
import { loadDotEnv, loadEnv, statePaths, type LatchEnv } from "./config/env.js";
import { runInit } from "./commands/init.js";
import { runInspect } from "./commands/inspect.js";
import { runProxy } from "./commands/proxy.js";
import { runReview } from "./commands/review.js";
import { VERIFY_EXIT, runVerify } from "./commands/verify.js";

/**
 * Run a command and turn its result (or thrown error) into the process exit code. The
 * environment (./.env included) is validated first, so a malformed variable stops every command.
 * A throw exits with `failureCode`.
 */
async function run(command: (env: LatchEnv) => Promise<number>, failureCode = 1): Promise<void> {
  try {
    loadDotEnv();
    process.exitCode = await command(loadEnv());
  } catch (error) {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = failureCode;
  }
}

const program = new Command()
  .name("latch")
  .description("Pin MCP tool capabilities in latch.lock and block unreviewed drift.")
  .version("0.0.0")
  .enablePositionalOptions()
  .option("--lockfile <path>", "path to latch.lock (default: $LATCH_LOCKFILE_PATH or ./latch.lock)")
  .option("--state-dir <path>", "local state directory (default: $LATCH_STATE_DIR or .latch next to the lockfile)");

const globals = () => statePaths(program.opts<{ lockfile?: string; stateDir?: string }>());

program
  .command("init")
  .description("wrap MCP servers in your client configs with the latch proxy and pin their tools")
  .addOption(new Option("--client <id>", "only configure this client").choices(SUPPORTED_CLIENTS))
  .option("--dry-run", "show planned changes without writing", false)
  .action((opts: { client?: (typeof SUPPORTED_CLIENTS)[number]; dryRun: boolean }) =>
    run(() => runInit({ ...opts, ...globals() })),
  );

program
  .command("review")
  .description("approve or reject pending tool changes")
  .option("--ui", "open the web review UI", false)
  .option("--port <port>", "web UI port (default: $LATCH_UI_PORT or 7777)", (v) => Number.parseInt(v, 10))
  .action((opts: { ui: boolean; port?: number }) =>
    run((env) => runReview({ ...opts, port: opts.port ?? env.uiPort, ...globals() })),
  );

program
  .command("verify")
  .description("CI check: exit non-zero if any server drifted from latch.lock")
  .option("--json", "machine-readable output", false)
  // An unexpected failure is an error (3), never drift (1): CI must tell the two apart.
  .action((opts: { json: boolean }) => run(() => runVerify({ ...opts, lockfilePath: globals().lockfilePath }), VERIFY_EXIT.error));

program
  .command("inspect")
  .description("show derived capabilities and findings for a server's tools without pinning")
  .option("--file <path>", "read a tools/list result from a JSON file")
  .argument("[server...]", "server command to spawn and query")
  .option("--json", "machine-readable output", false)
  .action((server: string[], opts: { file?: string; json: boolean }) =>
    run(() => runInspect({ ...opts, server: server.length > 0 ? server : undefined })),
  );

// Internal: what `latch init` writes into client configs. Hidden from --help.
program
  .command("proxy", { hidden: true })
  .requiredOption("--server <id>", "server id in latch.lock")
  .argument("<command...>", "real server command, after --")
  .passThroughOptions()
  .action((command: string[], opts: { server: string }) =>
    run((env) =>
      runProxy({
        serverId: opts.server,
        command,
        ...globals(),
        llm: env.llmEnabled ? { apiKey: env.llmApiKey!, baseUrl: env.llmBaseUrl, model: env.llmModel } : undefined,
      }),
    ),
  );

await program.parseAsync();
