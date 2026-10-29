#!/usr/bin/env node
import { Command, Option } from "commander";
import pc from "picocolors";
import { SUPPORTED_CLIENTS } from "./config/client-ids.js";
import { loadDotEnv, loadEnv, statePaths, type LatchEnv } from "./config/env.js";
import { userLockfilePath } from "./config/paths.js";
import { VERIFY_EXIT } from "./commands/exit-codes.js";
import { VERSION } from "./version.js";

// Each command's module is imported when that command runs, never at startup. Every wrapped MCP
// server keeps a `latch proxy` process alive, and loading the review UI, prompts and HTTP server
// it never uses would cost each one tens of MiB.

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
  .version(VERSION)
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
    run(async () => (await import("./commands/init.js")).runInit({ ...opts, ...globals() })),
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
  .description("link Claude Code (or --all clients) to latch with no questions: wrap their MCP servers and create the per-user latch.lock (installers run this)")
  .addOption(new Option("--client <id>", "client to link").choices(SUPPORTED_CLIENTS).default("claude-code"))
  .addOption(new Option("--all", "link (or with --remove, unlink) every MCP client found on this machine").conflicts("client"))
  .option("--remove", "unlink instead: give the client's servers their original commands back (latch.lock is kept)", false)
  .option("--dry-run", "show what would change without writing", false)
  .action((opts: { client: (typeof SUPPORTED_CLIENTS)[number]; all?: boolean; remove: boolean; dryRun: boolean }) => {
    const client = opts.all ? undefined : opts.client;
    return run(async () => {
      const { runSetup, runUnlink } = await import("./commands/setup.js");
      return opts.remove ? runUnlink({ client, dryRun: opts.dryRun }) : runSetup({ client, dryRun: opts.dryRun, ...setupGlobals() });
    });
  });

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
    run(async () => (await import("./commands/add.js")).runAdd({ ...opts, name, command, ...globals() })),
  );

program
  .command("review")
  .description("approve or reject pending tool changes")
  .option("--ui", "open the web review UI", false)
  .option("--port <port>", "web UI port (default: $LATCH_UI_PORT or 7777)", (v) => Number.parseInt(v, 10))
  .action((opts: { ui: boolean; port?: number }) =>
    run(async (env) =>
      (await import("./commands/review.js")).runReview({
        ...opts,
        port: opts.port ?? env.uiPort,
        // Only the built-in default may move to a free port; a port the user chose must not.
        portFallback: opts.port === undefined && !process.env.LATCH_UI_PORT?.trim(),
        dev: env.dev,
        ...readingGlobals(),
      }),
    ),
  );

program
  .command("verify")
  .description("CI check: exit non-zero if any server drifted from latch.lock")
  .option("--json", "machine-readable output", false)
  .option(
    "--config <file>",
    "MCP config with the servers' launch lines (latch.lock keeps only their hash); repeatable. Default: ./.mcp.json, then this machine's client configs",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  // An unexpected failure is an error (3), never drift (1): CI must tell the two apart.
  .action((opts: { json: boolean; config: string[] }) =>
    run(
      async () => (await import("./commands/verify.js")).runVerify({ json: opts.json, configs: opts.config, lockfilePath: readingGlobals().lockfilePath }),
      VERIFY_EXIT.error,
    ),
  );

program
  .command("watch")
  .description("keep every MCP client linked in the background: pin and wrap new servers as they appear, and notify about changes to review and blocked calls")
  .option("--once", "sync a single time, print what changed and exit", false)
  .option("--no-notify", "log notifications instead of showing them on the desktop")
  .action((opts: { once: boolean; notify: boolean }) =>
    run(async (env) => (await import("./commands/watch.js")).runWatch({ ...opts, ...setupGlobals(), logLevel: env.logLevel })),
  );

const lock = program
  .command("lock")
  .description("check latch.lock for edits made outside LatchVerify, and accept or undo them");
lock
  .command("status")
  .description("say whether latch.lock is what LatchVerify last wrote (exit 1 when it was changed outside it)")
  .action(() => run(async () => (await import("./commands/lock.js")).runLockStatus(readingGlobals())));
lock
  .command("accept")
  .description("trust latch.lock as it is now, after a git pull, merge or hand edit")
  .action(() => run(async () => (await import("./commands/lock.js")).runLockAccept(readingGlobals())));
lock
  .command("restore")
  .description("put back the last version of latch.lock that LatchVerify wrote")
  .action(() => run(async () => (await import("./commands/lock.js")).runLockRestore(readingGlobals())));

program
  .command("inspect")
  .description("show derived capabilities and findings for a server's tools without pinning")
  .option("--file <path>", "read a tools/list result from a JSON file")
  .argument("[server...]", "server command to spawn and query, with its own flags")
  .option("--json", "machine-readable output", false)
  .passThroughOptions()
  .action((server: string[], opts: { file?: string; json: boolean }) =>
    run(async () => (await import("./commands/inspect.js")).runInspect({ ...opts, server: server.length > 0 ? server : undefined })),
  );

// Internal: what `latch init` writes into client configs. Hidden from --help.
program
  .command("proxy", { hidden: true })
  .requiredOption("--server <id>", "server id in latch.lock")
  .argument("<command...>", "real server command, after --")
  .passThroughOptions()
  .action((command: string[], opts: { server: string }) =>
    run(async (env) =>
      (await import("./commands/proxy.js")).runProxy({
        serverId: opts.server,
        command,
        ...globals(),
        llm: env.llmEnabled ? { apiKey: env.llmApiKey!, baseUrl: env.llmBaseUrl, model: env.llmModel } : undefined,
        logLevel: env.logLevel,
      }),
    ),
  );

await program.parseAsync();
