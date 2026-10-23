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
| Approve or reject queued changes | `latch review` (terminal) | works |
| Browser review screen | `latch review --ui`, or `pnpm ui` for development | works |
| Demo servers (benign and rug pull) | `pnpm demo:benign`, `pnpm demo:evil` | works |
| LLM advisory pass | — | built in `src/analyze/llm.ts`, **not wired in yet** |

## 1. Install (once)

Requires Node 22+ and pnpm 11.

```sh
npm i -g pnpm@11.20.0          # or: corepack enable
pnpm install
pnpm build                                        # CLI → dist/
pnpm exec vite build --config web/vite.config.ts  # web UI → dist/web, needed by `latch review --ui`
pnpm link --global                                # puts `latch` on PATH
pnpm typecheck && pnpm test                       # everything should pass
```

`pnpm build` only compiles the CLI; the web UI needs the separate `vite build` step.
`latch` must be on PATH for client configs written by `latch init`; without
`pnpm link --global`, run `node dist/cli.js` instead of `latch` in the commands below.

## 2. Environment variables: none are required

**Nothing reads a `.env` file.** `loadEnv()` exists in `src/config/env.ts` but is not
called yet, and the review server reads `process.env` directly. Copying
`.env.example` to `.env` has no effect unless you export the variables into your shell.
Every variable has a working default:

| Variable | Default | Set it when |
|---|---|---|
| `LATCH_LOCKFILE_PATH` | `./latch.lock` | running `pnpm ui`, or `latch proxy` from another directory |
| `LATCH_STATE_DIR` | `./.latch` | same |
| `LATCH_UI_PORT` | `7777` | `pnpm ui` should use another API port |
| `LATCH_REVIEWER` | `git config user.email`, else the OS user | approvals should be recorded under another name |
| `DEMO_MUTATE` | unset | `1` makes the evil demo server start already poisoned |
| `ANTHROPIC_API_KEY`, `LATCH_LLM_ENABLED` | empty, `false` | no effect yet: the LLM pass is not wired in |

To load a `.env` anyway:

```sh
cp .env.example .env
set -a; . ./.env; set +a                                   # bash / zsh
```

```fish
for l in (string match -rv '^\s*(#|$)' < .env); set -gx (string split -m1 = $l); end   # fish
```

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

**Built UI, one process** (needs the `vite build` step from section 1):

```sh
latch --lockfile "$W/latch.lock" --state-dir "$W/.latch" review --ui --port 7777
```

It serves `http://127.0.0.1:7777` (localhost only), opens the browser, and stops on
Ctrl+C.

**Development mode** with hot reload: the API on 7777, Vite on 5173.

```sh
LATCH_LOCKFILE_PATH="$W/latch.lock" LATCH_STATE_DIR="$W/.latch" pnpm ui
```

Open `http://localhost:5173`; Vite proxies `/api` to the API. If the API is
unreachable the screen falls back to sample data and says so. Approving in the UI
rewrites the lockfile; a running proxy applies the decision to its next call without a
restart.

## 5. Use it with a real MCP client (optional)

```sh
latch --lockfile "$PWD/latch.lock" init --dry-run   # preview: writes nothing
latch --lockfile "$PWD/latch.lock" init             # pins tools, wraps client configs
```

`init` detects Claude Desktop, Claude Code, Cursor and VS Code configs, keeps a
timestamped `.bak` next to every config it rewrites, and puts `LATCH_LOCKFILE_PATH` and
`LATCH_STATE_DIR` into each wrapped entry so the proxy finds the lockfile wherever the
client starts it. Restart the client afterwards, then commit `latch.lock`. To undo,
restore the `.bak` copy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `latch: command not found` | `pnpm link --global`, or use `node dist/cli.js` |
| `latch review --ui`: "the review UI is not built" | `pnpm exec vite build --config web/vite.config.ts` |
| Every tool call blocked as `unpinned` from a client | the proxy found no lockfile; set `LATCH_LOCKFILE_PATH` in the client entry (`latch init` does this) |
| `port 7777 is in use` | `--port <other>` or set `LATCH_UI_PORT` for `pnpm ui` |
| The proxy Verify session does not block call 6 | the server started slowly; wait longer before sending call 6 |
