# Setup and try-it guide

How to install LatchVerify, what works today, and how to check each part by hand.
Commands are written for bash or zsh; fish equivalents are noted where they differ.

## What works today

| Part | Command | Status |
|---|---|---|
| Stdio proxy: forwards traffic, analyzes `tools/list`, blocks `tools/call` | `latch proxy` | works |
| CI check against `latch.lock` | `latch verify` (`--json`) | works |
| Read-only analysis of a tool list | `latch inspect` (`--json`) | works |
| Wrap client configs and pin tools | `latch init` (`--dry-run`) | works |
| Link Claude Code with no questions, per-user lockfile | `latch setup` (`--dry-run`, `--remove`) | works |
| Installers (Windows, deb, Arch, tar.gz) | Build installers workflow, see `INSTALL.md` | built and smoke-tested in CI |
| Add one server and pin its tools | `latch add <name> -- <command>` (`--dry-run`) | works |
| Approve or reject queued changes | `latch review` (terminal) | works |
| Browser review screen | `latch review --ui`, or `pnpm ui` for development | works |
| Demo servers (benign and rug pull), development only | `pnpm demo:benign`, `pnpm demo:evil` | works |
| Simulation and Dev Tools pages, development only | `LATCH_DEV=1` with `pnpm ui` or `latch review --ui` | works |
| Add a demo server to a client | `pnpm demo:add <preset> --client <id>` | works |
| Background sync and desktop notifications | `latch watch` (`--once`, `--no-notify`) | works |
| LLM advisory pass | — | built in `src/analyze/llm.ts`, **not wired in yet** |

## 1. Install (once)

To install a release instead of building from source, see [INSTALL.md](INSTALL.md).
The steps below build from source and require Node 22+ and pnpm 11.

```sh
npm i -g pnpm@11.20.0          # or: corepack enable
pnpm install
pnpm build                     # CLI → dist/, web UI → dist/web (served by `latch review --ui`)
pnpm link --global             # puts `latch` on PATH
pnpm typecheck && pnpm test    # everything should pass
```

Client configs written by `latch init` and `latch add` start the proxy by absolute path,
so they do not need `latch` on PATH. For the commands below, without
`pnpm link --global`, run `node dist/cli.js` instead of `latch`.

## 2. Environment variables: none are required

`latch` loads the `LATCH_*` lines of a `.env` file in the directory it runs in (copy
`.env.example`); variables already set in the shell win, and every other line of the file is
ignored. Every variable has a working default:

| Variable | Default | Set it when |
|---|---|---|
| `LATCH_LOCKFILE_PATH` | `./latch.lock` | running `pnpm ui`, or `latch proxy` from another directory |
| `LATCH_STATE_DIR` | `.latch` next to the lockfile | same |
| `LATCH_UI_PORT` | `7777` | `pnpm ui` should use another API port |
| `LATCH_REVIEWER` | `git config user.email`, else the OS user | approvals should be recorded under another name |
| `LATCH_LOG_LEVEL` | `info` | `debug` to see every frame the proxy holds, rewrites or answers; `warn` for a quieter stderr |
| `LATCH_LLM_ENABLED`, `LATCH_LLM_API_KEY` | `false`, empty | you want the optional LLM advisory pass (any OpenAI-compatible API; see `LATCH_LLM_BASE_URL` and `LATCH_LLM_MODEL`) |
| `LATCH_INTEGRITY_DIR` | `integrity` next to the per-user lockfile | tests: where lockfile integrity records and their key live |
| `LATCH_DEV` | `false` | development: the review UI adds the Simulation and Dev Tools pages, and the API serves `POST /api/simulate` and `/api/dev/presets` |
| `DEMO_MUTATE` | unset | `1` makes the evil demo server start already poisoned |

No `LATCH_*` variable ever reaches a server behind the proxy: the proxy removes them all from
the server's environment.

`.env` is gitignored; never commit it.

## 3. Try each feature

Work in a scratch directory so the repo stays clean.

```sh
W=$(mktemp -d)                    # fish: set W (mktemp -d)
cp latch.lock.example "$W/latch.lock"
```

**CI check.** Exit 0 against the benign server, exit 2 against the poisoned one:

```sh
latch --lockfile "$W/latch.lock" verify; echo "exit $?"
sed 's#demo/weather-server.ts#demo/evil-server.ts#' latch.lock.example > "$W/evil.lock"
DEMO_MUTATE=1 latch --lockfile "$W/evil.lock" verify; echo "exit $?"
latch --lockfile "$W/latch.lock" verify --json
```

In fish, use `env DEMO_MUTATE=1 latch ...` and `$status` instead of `$?`.

**Read-only analysis:**

```sh
latch inspect --file tests/fixtures/poisoned-tools.json   # exit 2: 3 tools would be hard-blocked
latch inspect -- pnpm -s demo:benign                      # same result as the benign fixture file
```

**Proxy and rug pull.** Three calls flip the evil server; the proxy then blocks
`get_forecast` with a `-32001` error and queues the changes:

```sh
( printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}'
  sleep 5
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_forecast","arguments":{"latitude":1,"longitude":2}}}'
  sleep 1 ) | latch --lockfile "$W/latch.lock" --state-dir "$W/.latch" proxy --server weather -- pnpm -s demo:evil
cat "$W/.latch/pending.json" "$W/.latch/events.jsonl"
```

Run this block in bash; in fish, start `bash` first.

**Review in the terminal.** Arrow keys and Enter choose. Tier-3 approvals ask for
confirmation, and the cursor starts on Skip for blocked changes:

```sh
latch --lockfile "$W/latch.lock" --state-dir "$W/.latch" review
git diff --no-index latch.lock.example "$W/latch.lock"   # shows an approval
```

## 4. Run the review UI

**Built UI, one process** (needs `pnpm build` from section 1):

```sh
latch --lockfile "$W/latch.lock" --state-dir "$W/.latch" review --ui --port 7777
```

It serves `http://127.0.0.1:7777` (localhost only), opens the browser, and stops on
Ctrl+C.

**Development mode** with hot reload: the API on 7777, Vite on 5173.

```sh
LATCH_LOCKFILE_PATH="$W/latch.lock" LATCH_STATE_DIR="$W/.latch" pnpm ui
```

Open `http://localhost:5173`; Vite proxies `/api` to the API. The top bar shows
whether the API is reachable. If it is not, the Review Queue shows labeled sample
data with Approve and Reject disabled, and the other pages show an error. Only the Vite
dev server does this: the built UI never shows sample data. Approving
in the UI rewrites the lockfile; a running proxy applies the decision to its next call
without a restart.

The UI has seven pages: Overview, MCP Servers, Review Queue, Approved Tools, Audit
Log, Git & CI, and Settings. With `LATCH_DEV=1` set for the API (in `.env`, or before
`pnpm ui` or `latch review --ui`), two more appear: Simulation rehearses the demo rug pull in
memory, and Dev Tools adds the demo servers to an MCP client in one click. Settings has six themes plus "Follow system"; the
choice is kept in the browser's local storage.

## 5. Use it with a real MCP client (optional)

```sh
latch --lockfile "$PWD/latch.lock" init --dry-run   # preview: writes nothing
latch --lockfile "$PWD/latch.lock" init             # pins tools, wraps client configs
```

`init` detects the configs of every supported client (the list and paths are in
[INSTALL.md](INSTALL.md#what-installing-does)), changes only the `command` and `args` of the
entries it wraps (env, where keys live, and comments stay as they are), and passes `--lockfile` and
`--state-dir` in those args so the proxy finds the lockfile wherever the client starts it. It
starts no server: each is recorded in `latch.lock` and its tools are pinned the first time the
client starts it. A config it cannot read is reported and left alone. Restart the client
afterwards, then commit `latch.lock`. To undo, run `latch setup --remove --all`.

Without a project, `latch setup` does the same for the clients you choose, with a per-user
lockfile instead of `./latch.lock` (`~/.config/latchverify/latch.lock` on Linux):

```sh
latch setup                          # lists the clients found and asks which to connect
latch setup --client claude-code     # connects one without asking (--all: every client)
latch setup --dry-run --all          # preview: writes nothing
latch setup --remove --client claude-code   # original entries back; keeps latch.lock
latch watch                          # keeps connected clients linked, with desktop notifications
```

`latch review` and `latch verify` open that lockfile from any directory without `./latch.lock`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `latch: command not found` | `pnpm link --global`, or use `node dist/cli.js` |
| `latch review --ui`: "the review UI is not built" | `pnpm build` |
| Every tool call blocked as `unpinned` from a client | the proxy found no lockfile; pass `--lockfile <path>` before `proxy` in the client entry (`latch init` and `latch setup` do this) |
| `port 7777 is in use` | `--port <other>` or set `LATCH_UI_PORT` for `pnpm ui` |
| The proxy Verify session does not block call 6 | the server started slowly; wait longer before sending call 6 |
