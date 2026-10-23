# Person 2 handoff: what Vinayak built

Context for Person 1 (Anirudh Rao). Everything below is merged into `main`.
All eleven Person 2 tasks from [`task_split.md`](task_split.md) are done.

| Task | What | Files | PR |
|---|---|---|---|
| 1 | JSON-RPC transport | `src/proxy/transport.ts` | #5 |
| 2 | Blocker | `src/proxy/blocker.ts` | #7 |
| 3 | Pending queue and event log | `src/store/pending.ts`, `src/store/events.ts` | #8 |
| 4 | Demo servers | `demo/weather-server.ts`, `demo/evil-server.ts`, `demo/README.md` | #11 |
| 5 | Env and client configs | `src/config/env.ts`, `src/config/clients.ts` | #12 |
| 6 | Interceptor and proxy lifecycle | `src/proxy/interceptor.ts`, `src/proxy/index.ts`, `src/proxy/analysis.ts` | #15 |
| 7 | `latch verify` | `src/commands/verify.ts`, `src/proxy/capture.ts` | #16 |
| 8 | `latch inspect` | `src/commands/inspect.ts`, `src/commands/text.ts` | #17 |
| 9 | `latch proxy` | `src/commands/proxy.ts` | #18 |
| 10 | `latch init` | `src/commands/init.ts` | #19 |
| 11 | `latch review` | `src/commands/review.ts` | #20 |

Tests live next to each area: `tests/proxy/`, `tests/store/pending.test.ts`,
`tests/store/events.test.ts`, `tests/config/`, `tests/commands/` and `tests/demo/`.
`tests/demo/` is new and not in the ownership list; it only tests `demo/*`. Run them
all with `pnpm test`.

---

## How it fits together

1. `latch init` finds the client configs, pins each server's current tools in
   `latch.lock`, then rewrites each entry to run `latch proxy`, with
   `LATCH_LOCKFILE_PATH` and `LATCH_STATE_DIR` in its `env`.
2. The client starts `latch proxy`, which spawns the real server and routes every
   line through the interceptor.
3. Every `tools/list` response, including the proxy's own re-fetch after
   `notifications/tools/list_changed`, runs through `analyzeToolList`. New and
   changed tools go to `.latch/pending.json`.
4. Each `tools/call` is checked by `shouldBlock`. A blocked call gets a `-32001`
   error and never reaches the server.
5. `latch review` (terminal) or `latch review --ui` (your review API and web UI)
   approves or rejects. The running proxy picks the decision up without a restart.
6. `latch verify` runs the same pipeline in CI and exits non-zero on drift.

---

## Module guide

### `src/proxy/transport.ts`
- `parseLine(line)` always keeps `raw`. `message` is set only for a JSON object with
  `jsonrpc: "2.0"`, so batches (arrays) give `null`. It never throws.
- `isRequest`, `isNotification` and `isResponse` check field types at runtime. At most
  one is true, and a message with `"method": 5` or `"id": {}` matches none.
- `readFrames(input, onFrame)` uses `readline` with `terminal: false`. The returned
  close function guarantees no frame afterwards, since readline keeps emitting buffered
  lines after `close()`. Input errors are left to the caller's own listener.
- `writeLine(output, line)` writes exactly one `\n` in a single write and resolves once
  flushed. It **throws** `TypeError` if the line contains another CR or LF, which
  would let one message smuggle in another.
- `spawnUpstream(command, args, env?)` uses no shell. `env` is merged over
  `process.env`, and a key set to `undefined` unsets the variable. The child's stderr
  goes to ours.

### `src/proxy/blocker.ts`
- `shouldBlock(serverId, toolName, lockfile, pending)` picks the strongest reason:
  - `hard_block` when a tier-3 change is pending;
  - `pending_review` when a tier-2 change is pending;
  - `unpinned` when the tool isn't in `latch.lock`, whatever the tier of any pending change.
- A pending change whose `after` composite hash is already pinned is ignored, so a
  teammate's merged approval unblocks without re-review.
- `buildBlockError(id, toolName, reason)` gives code `-32001` and a message naming
  `latch review`. The tool name goes through `escapeForEvidence` and is cut at 128
  characters.
- `BlockReason` gained `{ kind: "unverified" }`. Only the interceptor uses it;
  `shouldBlock` never returns it.

### `src/proxy/analysis.ts`
- `analyzeToolList(serverId, result, lockfile, specVersion, now)` returns
  `{ toolCount, changes, unchanged }`, or `null` when `result` has no `tools` array.
  The proxy, `verify`, `inspect` and `init` all use it.
- It runs your pipeline in the order your handoff gives, and the text findings **are**
  passed to `classifyTier`.
  - Pattern and Unicode detectors run on `name`, `title`, `description`,
    `annotations.title`, and every `title` and `description` nested in `inputSchema`.
  - The Unicode detector alone also runs on every other schema string and property name.
- A tool whose composite hash equals its pin counts as unchanged and is **not**
  re-analyzed, so detector updates never cause phantom drift.
- **Fails closed.** A tool that fails `McpToolSchema`, nests too deeply, or is listed
  twice becomes a tier-3 change:
  - it has a critical `capability_gain` finding;
  - its hashes are random, so neither the blocker nor an approval can ever treat it as pinned.
- `after.approvedBy` is the placeholder `UNAPPROVED`, which `applyApproval` replaces.
  `specVersion` is `"unknown"` when no `initialize` was seen.
- Cross-server references count tools pinned for **other** servers, minus names this
  list also has. Clients namespace tools per server, so a shared name is not a reference.
- The cached LLM advisory is **not** passed to `extractCapabilities` (see the
  follow-ups).

### `src/proxy/interceptor.ts`
- `InterceptorContext` gained these fields:
  - `stateDir`;
  - `observed`: the latest change per tool, kept for the session;
  - `verified`;
  - `ownRequests`;
  - `sendToServer`;
  - `refresh`;
  - `log`.
- `InterceptDecision` gained `{ action: "drop" }`.
- `routeFrame`:
  - A client batch is refused with `-32600`, since a `tools/call` inside an array would
    slip past enforcement.
  - `tools/call` goes to `onToolsCall`.
  - Only `initialize` and `tools/list` ids are tracked, so the map can't grow without bound.
  - After forwarding `notifications/initialized`, the proxy sends its own `tools/list`.
    Responses to the proxy's own requests are analyzed and dropped.
- `onToolsList`:
  - queues every new or changed tool, tier 0–3; tier 0/1 so that review can fold them in;
  - logs `change_detected` for each, and `auto_passed` for tier 0/1;
  - never creates a new change id for a definition it has already seen.
- `onToolsCall`:
  - runs `shouldBlock` over the queue **plus** `observed`, so a definition rejected in
    review stays blocked while the server keeps serving it;
  - answers a call without a string tool name with `-32602`;
  - logs every block as `call_blocked`.
- `onToolsListChanged` marks the server unverified, records `list_changed` and sends the
  proxy's own `tools/list`. It follows `nextCursor` for up to `MAX_OWN_PAGES` pages.

### `src/proxy/index.ts` (`startProxy`)
- Frames from both directions go through **one queue in arrival order**. A `tools/call`
  that arrives after a `tools/list` response is always checked against that list's
  analysis.
- A `tools/call` that arrives while the server is unverified is **held**, together with
  every client frame after it, until a list has been analyzed. This is what makes the
  pipelined Task 6 Verify session work. After `holdTimeoutMs` (10 s) the held frames
  are released and still-unverified calls are blocked.
- `refresh` re-reads `latch.lock` and the queue when their inode, size or mtime changes,
  so review decisions apply live. A malformed new file is reported once and the last
  good copy stays in force.
- If routing itself throws, a `tools/call` gets an error instead of being forwarded
  unchecked, and the server is marked unverified.
- SIGINT, SIGTERM and SIGHUP are passed on to the server. `startProxy` resolves with the
  server's exit code, or 128 plus the signal number.
- `ProxyOptions` gained optional `input`, `output` and `holdTimeoutMs`, for tests.

### `src/proxy/capture.ts`
- `captureTools(command, args, { timeoutMs, env })` acts as a minimal MCP client:
  `initialize`, `notifications/initialized`, then `tools/list` following `nextCursor`.
  It returns `{ tools, specVersion }`.
- Server requests get an answer: `ping` an empty result, anything else `-32601`.
- **Throws** `CaptureError`, with a message safe to print, when the server:
  - can't start, or exits early;
  - writes a line to stdout that isn't JSON-RPC;
  - answers with an error, or without a tools array;
  - pages more than 100 times;
  - misses the 60 s deadline.
- The server is shut down by closing stdin, then SIGTERM, then SIGKILL.

### `src/store/pending.ts` and `src/store/events.ts`
- `readPending(stateDir)`: a missing file gives `[]`. A corrupt file or an invalid entry
  **throws**, naming the file and the field. It is never treated as empty: dropping an
  entry could unblock a tool.
- `writePending(stateDir, changes)` validates first, then writes atomically: temp file,
  fsync, rename.
- `enqueue` replaces any entry for the same server and tool, and any entry with the same
  id. `dequeue` removes by id. Both are pure.
- `appendEvent(stateDir, event)` validates against a zod copy of `LatchEvent`, which a
  compile-time check keeps identical to the type. If the log ends in a torn line, the
  event starts on a fresh line.
- `readEvents(stateDir, limit?)` streams the log, skips malformed lines and keeps the
  newest `limit` events. **Throws** `RangeError` for a negative or fractional `limit`.

### `src/config/env.ts` and `src/config/clients.ts`
- `loadEnv(env)` uses the `.env.example` defaults. Values are trimmed and a blank value
  means unset. Paths resolve against the cwd. One error lists every bad variable, and the
  API key is never in it.
- `clientConfigPath(client, platform)`:
  - Claude Desktop and VS Code live in the app data folder (macOS Application Support,
    `%APPDATA%`, or `$XDG_CONFIG_HOME`/`~/.config`);
  - Claude Code uses `~/.claude.json`;
  - Cursor uses `~/.cursor/mcp.json`.
- VS Code keeps servers under `servers`, the others under `mcpServers`; `serversKey`
  returns the right one.
- `detectClients()` returns only stdio entries it can wrap. A JSONC file with comments
  is skipped, never rewritten.
- `wrapWithProxy` / `unwrapProxy` are pure and keep key order. `wrapWithProxy` is
  idempotent however `latch` is spelled, and **throws** for an id that is empty or
  starts with `-`.
- `writeClientConfig` merges into the file **as it is on disk now**, because clients
  rewrite their config while running. It also:
  - writes a timestamped `.bak` first;
  - does nothing when the values are unchanged;
  - keeps indentation, CRLF, permission bits and symlinks;
  - writes atomically.

### `src/commands/*`
- **`latch proxy`:** when `--lockfile` / `--state-dir` are left at their CLI defaults,
  `LATCH_LOCKFILE_PATH` / `LATCH_STATE_DIR` from the environment apply. An explicit flag
  wins. stdout carries only JSON-RPC.
- **`latch verify`:**
  - exits 0 for ok (tier 0/1 changes and removed tools pass);
  - exits 1 for drift (a tier-2 change, or an unpinned tool at any tier);
  - exits 2 for a hard block (any tier 3);
  - exits 3 for an error, including a **missing or invalid lockfile**, so CI never passes
    on an empty check.
  `--json` emits one report with `version: 1`.
- **`latch inspect`:** reads `--file` or a live server, and never touches the lockfile or
  disk. It exits 2 when any tool would be tier 3 if first seen, 3 on error, and 0
  otherwise. `--json` emits one report with `version: 1`.
- **`latch init`:**
  - writes `latch.lock` **before** any config, so a config is never wrapped around pins
    that don't exist;
  - never re-pins a server already in `latch.lock`, so drift goes through review;
  - holds back tools with critical findings instead of trusting them on first use;
  - lets you pick servers with a multiselect in a terminal, and takes all of them otherwise;
  - is a no-op on a second run;
  - warns when `latch` isn't on PATH.
- **`latch review`:**
  - orders highest tier first, then oldest, and keeps the listing order for ties;
  - starts the cursor on Skip for tier 2 and 3, and asks for a second confirmation
    before approving tier 3;
  - re-reads the lockfile and queue before every decision, and won't approve a change
    that was replaced meanwhile;
  - `--ui` calls your `startUiServer` with `dist/web` and opens the browser.
- **`src/commands/text.ts`:** `printable()` shows control and format characters as
  `[U+XXXX]`. Every command prints untrusted text through it.

### `demo/`
- Both servers share one JSON-RPC core, `serveStdio`, built on the proxy's transport.
  They start only when run directly (`isEntryPoint`), so tests can import them.
- `evil-server` is byte-identical to `weather-server`, `serverInfo` included, until the
  third `tools/call` or SIGUSR1. It then switches once and sends `list_changed`.
  `DEMO_MUTATE=1` starts it mutated.
- Send SIGUSR1 only after the server is up; before its handler is installed, Node
  treats SIGUSR1 as "start the debugger".
- The poisoned tools never read, run or send anything, and only the **length** of an
  exfiltrated `notes` value is logged.

---

## Decisions that differ from the original stubs

| Stub said | Built | Why |
|---|---|---|
| decisions are forward, rewrite or respond | added `drop` | the proxy's own `tools/list` replies must not reach the client |
| `InterceptorContext` has five fields | added `stateDir`, `observed`, `verified`, `ownRequests`, `sendToServer`, `refresh`, `log` | the handlers had no way to persist, re-fetch or reload |
| block unpinned first | a pending change outranks `unpinned` | a poisoned new tool is reported as the hard block it is, with its change id |
| calls before verification are blocked | held until a list is analyzed (blocked after 10 s) | clients pipeline requests; refusing broke the Task 6 session |
| client batches are forwarded raw | refused with `-32600` | a `tools/call` inside an array would bypass enforcement |
| `writeClientConfig` writes `config.raw` back | merges into the current file | Claude Code rewrites `~/.claude.json` while `init` waits on a prompt |
| wrapped entries carry args only | `init` also sets `LATCH_LOCKFILE_PATH` / `LATCH_STATE_DIR`, which `latch proxy` reads | clients start servers from `/`; the proxy would find no lockfile and block everything |
| `init` pins every tool | tools with critical findings are held for review | trust on first use must not trust hidden instructions |
| `verify` errors only on start failure | a missing lockfile is also exit 3 | CI must not pass on an empty check |
| `inspect` (no exit code specified) | exit 2 when any tool would be tier 3 | usable as a pre-install gate in CI |

---

## Open follow-ups (shared files: do them together)

1. **Web UI build:** `pnpm build` only runs `tsc`. `latch review --ui` needs
   `pnpm exec vite build --config web/vite.config.ts` and says so when the build is
   missing. Add it to the `build` script in `package.json`.
2. **Cross-process locking for `.latch/pending.json`:** the proxy, the review API and
   `latch review` all read, modify and write it. Each write is atomic, but two writers at
   the same moment can lose an update. This matches your handoff's note on approve and reject.
3. **`src/ui/server.ts` still reads env vars itself** (its `shortcut:` comment). Switch
   it to `loadEnv()`. When the LLM env vars are renamed (your follow-up 1), rename them
   in `loadEnv` too: it still reads `ANTHROPIC_API_KEY`.
4. **`latch.lock.example` domains** (your follow-up 4): against the example, a reworded
   `get_forecast` is tier 1 (`Narrowed: network.domains:api.weather.gov`). It still
   auto-passes, but the Sync 1 checklist expects tier 0. Regenerate the example with
   `latch init`.
5. **Task 6 Verify timing:** the block's `sleep 2` assumes `pnpm -s demo:evil` starts
   within 2 s. If the server starts slowly, call 6 is checked before the rug pull happens.
   Use `sleep 5`, or wait for the `list_changed` line.
6. **Windows:** `spawnUpstream` can't start `.cmd` shims such as `npx` without a shell.
   `cross-spawn` would fix it, which means a new dependency.
7. **`src/cli.ts` is frozen**, so a few options exist only in code:
   - `timeoutMs` for `verify`, `inspect` and `init`;
   - a `--state-dir` for `init`, which uses `<lockfile dir>/.latch`.
   `latch proxy` detects "flag not given" by comparing against the CLI's default strings.
8. **Not detected yet:**
   - tool shadowing (one tool name on two servers) is not flagged;
   - Claude Code's per-project servers are not read;
   - VS Code's per-entry `cwd` is ignored;
   - `http` transport servers are reported as errors.
9. **LLM advisory not wired in:** `analysis.ts` doesn't pass a cached advisory to
   `extractCapabilities`. Its findings are capped at `warn`, so tiers don't change, but
   the review screen won't show them.

---

## Verify

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm exec vite build --config web/vite.config.ts   # for latch review --ui
node dist/cli.js --lockfile latch.lock.example verify; echo "exit $?"   # exit 0
node dist/cli.js inspect --file tests/fixtures/poisoned-tools.json      # exit 2
```

Each task's Verify block in `task_split.md` still applies (see follow-up 5 for
Task 6). Run the Sync 1 and Sync 2 checklists together; with every task merged, Sync 2
(the full `docs/DEMO.md` script) is what is left.
