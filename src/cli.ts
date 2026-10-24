#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import pc from "picocolors";
import { SUPPORTED_CLIENTS } from "./config/clients.js";
import { loadDotEnv, loadEnv, statePaths, type LatchEnv } from "./config/env.js";
import { userLockfilePath } from "./config/paths.js";
import { runAdd } from "./commands/add.js";
import { runInit } from "./commands/init.js";
import { runInspect } from "./commands/inspect.js";
import { runProxy } from "./commands/proxy.js";
import { runReview } from "./commands/review.js";
import { runSetup } from "./commands/setup.js";
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

/** This install's version: package.json sits one level above both src/cli.ts and dist/cli.js. */
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const program = new Command()
  .name("latch")
  .description("Pin MCP tool capabilities in latch.lock and block unreviewed drift.")
  .version(version)
  .enablePositionalOptions()
  .option("--lockfile <path>", "path to latch.lock (default: $LATCH_LOCKFILE_PATH or ./latch.lock; review and verify fall back to the per-user lockfile from `latch setup`)")
  .option("--state-dir <path>", "local state directory (default: $LATCH_STATE_DIR or .latch next to the lockfile)");

const globals = () => statePaths(program.opts<{ lockfile?: string; stateDir?: string }>());
/**
 * For commands that read or review pins: outside a project (no ./latch.lock) they open the
 * per-user lockfile `latch setup` created, so an installed latch never has to ask where it is.
 */
const readingGlobals = () => statePaths(program.opts<{ lockfile?: string; stateDir?: string }>(), process.env, { fallbackLockfile: userLockfilePath() });

program
  .command("init")
  .description("wrap MCP servers in your client configs with the latch proxy and pin their tools")
  .addOption(new Option("--client <id>", "only configure this client").choices(SUPPORTED_CLIENTS))
  .option("--dry-run", "show planned changes without writing", false)
  .action((opts: { client?: (typeof SUPPORTED_CLIENTS)[number]; dryRun: boolean }) =>
    run(() => runInit({ ...opts, ...globals() })),
  );

/**
 * For latch setup: the per-user lockfile unless --lockfile or LATCH_LOCKFILE_PATH names another.
 * Never ./latch.lock, so where an installer happens to run it does not matter.
 */
const setupGlobals = () => {
  const flags = program.opts<{ lockfile?: string; stateDir?: string }>();
  const fromEnv = process.env.LATCH_LOCKFILE_PATH?.trim();
  return statePaths({ ...flags, lockfile: flags.lockfile ?? (fromEnv ? undefined : userLockfilePath()) });
};

program
  .command("setup")
  .description("link Claude Code to latch with no questions: wrap its MCP servers and create the per-user latch.lock (installers run this)")
  .addOption(new Option("--client <id>", "client to link").choices(SUPPORTED_CLIENTS).default("claude-code"))
  .option("--dry-run", "show what would change without writing", false)
  .action((opts: { client: (typeof SUPPORTED_CLIENTS)[number]; dryRun: boolean }) => run(() => runSetup({ ...opts, ...setupGlobals() })));

program
  .command("add")
  .description("put one MCP server behind latch: pin its tools and add it to a client config")
  .usage("[options] <name> -- <command> [args...]")
  .argument("<name>", "server id, used in the client config and latch.lock")
  .argument("<command...>", "the real server command and its arguments, after --")
  .addOption(new Option("--client <id>", "client config to add it to").choices(SUPPORTED_CLIENTS).default("claude-desktop"))
  .option("--env <KEY[=VALUE]>", "server environment variable; a bare KEY copies it from this shell (repeatable)", (value, previous: string[]) => [...previous, value], [])
  .option("--dry-run", "show what would be pinned and added without writing", false)
  .action((name: string, command: string[], opts: { client: (typeof SUPPORTED_CLIENTS)[number]; env: string[]; dryRun: boolean }) =>
    run(() => runAdd({ ...opts, name, command, ...globals() })),
  );

program
  .command("review")
  .description("approve or reject pending tool changes")
  .option("--ui", "open the web review UI", false)
  .option("--port <port>", "web UI port (default: $LATCH_UI_PORT or 7777)", (v) => Number.parseInt(v, 10))
  .action((opts: { ui: boolean; port?: number }) =>
    run((env) =>
      runReview({
        ...opts,
        port: opts.port ?? env.uiPort,
        // Only the built-in default may move to a free port; a port the user chose must not.
        portFallback: opts.port === undefined && !process.env.LATCH_UI_PORT?.trim(),
        ...readingGlobals(),
      }),
    ),
  );

program
  .command("verify")
  .description("CI check: exit non-zero if any server drifted from latch.lock")
  .option("--json", "machine-readable output", false)
  // An unexpected failure is an error (3), never drift (1): CI must tell the two apart.
  .action((opts: { json: boolean }) => run(() => runVerify({ ...opts, lockfilePath: readingGlobals().lockfilePath }), VERIFY_EXIT.error));

program
  .command("inspect")
  .description("show derived capabilities and findings for a server's tools without pinning")
  .option("--file <path>", "read a tools/list result from a JSON file")
  .argument("[server...]", "server command to spawn and query, with its own flags")
  .option("--json", "machine-readable output", false)
  .passThroughOptions()
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
