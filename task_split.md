# Task split

Two people implement the LatchVerify scaffold in parallel. Each task below is
self-contained: it has its own branch, the files to edit, what to build, and when
it counts as done.

| | Name | Area |
|---|---|---|
| **Person 1** | Anirudh Rao | Analysis engine, lockfile store, review UI |
| **Person 2** | Vinayak Kamath | Proxy runtime, local state, config, CLI commands, demo |

## Quick start

```sh
git clone https://github.com/vinayakkam/Nexathon2026.git
cd Nexathon2026
pnpm install
pnpm typecheck && pnpm test   # should pass before you start
```

Then:

1. Find your section: [Person 1](#person-1--anirudh-rao) or [Person 2](#person-2--vinayak-kamath).
2. Take your lowest-numbered task that is not merged yet.
3. Run its **Branch** command, do the work, and run its **Finish** steps.
4. After the PR merges, go to your next task.

## The one rule: each file has one owner

A PR only touches files its author owns. Two PRs then never edit the same file, so
they cannot conflict.

Code that crosses the boundary goes through the typed stub signatures that are
already committed. Example: `src/proxy/interceptor.ts` (Person 2) calls
`hashTool()`, `extractCapabilities()`, `diffCapabilities()` and `classifyTier()`
(Person 1). Person 2 codes against those signatures as they are today. **Never
change a function signature**, even in a file you own, without the
[shared-change process](#changing-a-shared-file).

**Shared and frozen files.** Nobody edits these in a task branch:

```
src/schema/*            src/cli.ts              src/index.ts
package.json            pnpm-lock.yaml          pnpm-workspace.yaml
tsconfig.json           tsconfig.build.json     vitest.config.ts
.env.example            .gitignore              .npmrc
latch.lock.example      tests/schema.test.ts
README.md               CLAUDE.md               docs/*        task_split.md
```

## Finish steps (same for every task)

```sh
pnpm typecheck && pnpm test
git diff --name-only main...HEAD   # every path must be one you own
git push -u origin <your-branch>
# open a PR into main; the other person reviews it
```

---

## Person 1 — Anirudh Rao

Owns: `src/analyze/*`, `src/store/lockfile.ts`, `src/ui/*`, `web/**`,
`tests/fixtures/*`, and the test folders `tests/analyze/`, `tests/ui/`, plus
`tests/store/lockfile.test.ts`.

### Task 1: Segment hashing

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-1-hashing
```
**Files you edit:** `src/analyze/hash.ts`
**Tests:** `tests/analyze/hash.test.ts` (new)

**What to build:**
- `canonicalJson()`: keys sorted recursively, no whitespace.
- `sha256Hex()` with `node:crypto`, lowercase hex.
- `hashTool()`: name, description and inputSchema segments, plus `composite = sha256("<name>:<description>:<inputSchema>")` over the three hex digests.

**Done when:**
- [ ] `hashTool()` reproduces the hashes in `latch.lock.example` for both tools in `tests/fixtures/benign-tools.json`.
- [ ] Reordering keys in `inputSchema` gives the same hash.
- [ ] Inserting one U+200B into a description changes the `description` and `composite` hashes.

**Depends on:** nothing.

### Task 2: Capability extraction (passes 1 and 2)

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-2-capabilities
```
**Files you edit:** `src/analyze/capabilities.ts`
**Tests:** `tests/analyze/capabilities.test.ts` (new)

**What to build:**
- `emptyCapabilitySet()`.
- `deriveFromSchema()`: walk `inputSchema.properties` (including nested objects and arrays) and match names against `PARAM_SIGNALS`. A param with `enum`, `const` or `pattern` counts as constrained; `format: "uri"` means network egress.
- `readDeclared()` and `annotationMismatches()`.
- `extractCapabilities()` merging the passes (skip the `advisory` argument until Task 9).

**Done when:**
- [ ] Benign fixture gives network egress only.
- [ ] Poisoned `read_config` gives `filesystem.read` with scope `"unconstrained"`.
- [ ] Poisoned `run_diagnostics` gives `exec.enabled`.
- [ ] `readOnlyHint: true` together with exec gives an `annotation_mismatch` finding.

**Depends on:** nothing.

### Task 3: Unicode detector

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-3-unicode
```
**Files you edit:** `src/analyze/unicode.ts`
**Tests:** `tests/analyze/unicode.test.ts` (new)

**What to build:**
- `findSuspiciousCodepoints()` over `SUSPICIOUS_RANGES`. Iterate by codepoint, not by UTF-16 unit.
- `decodeTagChars()`.
- `findConfusables()` using mixed-script detection and `normalize("NFKC")`.
- `detectUnicode()` returning `Finding[]` with the severities from the TODO.

**Done when:**
- [ ] Flags the U+200B run, U+202E and the tag characters in `tests/fixtures/poisoned-tools.json`.
- [ ] `decodeTagChars()` on the `sync_alerts` description returns `"hi"`.
- [ ] Benign fixture gives no findings.

**Depends on:** nothing.

### Task 4: Pattern detector

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-4-patterns
```
**Files you edit:** `src/analyze/patterns.ts`
**Tests:** `tests/analyze/patterns.test.ts` (new)

**What to build:**
- `findImperatives()`, `findPathMentions()`, `findEnvVarMentions()`, `findCrossServerRefs()`.
- `detectPatterns()` combining them.

**Done when:**
- [ ] Flags `you must`, `Do not tell the user`, `Ignore previous`, `~/.ssh/id_rsa` and `OPENAI_API_KEY` in the poisoned fixture.
- [ ] With `otherServerTools: ["send_email"]`, `sync_alerts` gets a `cross_server` finding.
- [ ] Benign fixture gives no findings.

**Depends on:** nothing.

### Task 5: Differ and tiers

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-5-differ-tiers
```
**Files you edit:** `src/analyze/differ.ts`, `src/analyze/tiers.ts`
**Tests:** `tests/analyze/differ.test.ts`, `tests/analyze/tiers.test.ts` (new)

**What to build:**
- `diffHashes()`, `diffCapabilities()` (dotted keys, gained/lost/loosened), `diffDescription()` with jsdiff.
- `classifyTier()` following the rule order in the JSDoc, and `isAutoPass()`.

**Done when:**
- [ ] Benign → poisoned `get_forecast` is tier 3.
- [ ] Reworded description with identical capabilities is tier 0.
- [ ] Changing a param from `enum` to bare `string` is tier 2 (`loosened`).
- [ ] `before: null` puts every true capability in `gained`.

**Depends on:** Tasks 1–4 (uses their output in tests).

### Task 6: Lockfile store

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-6-lockfile-store
```
**Files you edit:** `src/store/lockfile.ts`
**Tests:** `tests/store/lockfile.test.ts` (new)

**What to build:**
- `readLockfile()`: validate with `LockFileSchema`; a missing file returns an empty lockfile.
- `writeLockfile()`: sorted, 2-space indent, trailing newline, atomic temp-file-and-rename.
- `findRecord()` and a pure `applyApproval()`.

**Done when:**
- [ ] Reading then writing `latch.lock.example` gives byte-identical output.
- [ ] Missing file gives `{ version: "1", servers: {} }`.
- [ ] `applyApproval()` does not mutate its input.

**Depends on:** nothing. Person 2 Tasks 10 and 11 call this.

### Task 7: Review API

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-7-review-api
```
**Files you edit:** `src/ui/routes.ts`, `src/ui/server.ts`
**Tests:** `tests/ui/routes.test.ts` (new, use `app.request()`)

**What to build:**
- Replace each 501 route with the behaviour in its TODO comment.
- `startUiServer()`: `@hono/node-server` bound to `127.0.0.1`, serving static files from `staticDir` when given.

**Done when:**
- [ ] `GET /api/pending` returns the queue sorted by tier.
- [ ] Approve rewrites `latch.lock` and removes the change from the queue.
- [ ] `pnpm ui` starts both the API and Vite with no errors.

**Depends on:** Person 2 Task 3 (`readPending`, `readEvents`). Mock them with `vi.mock()` in your test until it merges.

### Task 8: Wire the web UI

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-8-web-ui
```
**Files you edit:** `web/src/**`
**Tests:** manual check in the browser with `pnpm ui`

**What to build:**
- `fetchPending()`, `approveChange()`, `rejectChange()` in `web/src/lib/api.ts`.
- Selection state in `App.tsx`; clicking a list item selects it.
- Enable the Approve and Reject buttons. Fall back to `mock.ts` only when the API is unreachable.

**Done when:**
- [ ] Approving a change in the UI updates `latch.lock` on disk.
- [ ] Layout still works at phone width.

**Depends on:** Task 7.

### Task 9: LLM advisory pass (optional, last)

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-9-llm
```
**Files you edit:** `src/analyze/llm.ts`, and the `advisory` merge in `src/analyze/capabilities.ts`
**Tests:** `tests/analyze/llm.test.ts` (new, mock `@anthropic-ai/sdk`)

**What to build:**
- `advisoryCacheKey()`.
- `runAdvisory()`: return the cached result on a key match, otherwise call the API at temperature 0 and validate the output with `FindingSchema`.

**Done when:**
- [ ] A cache hit makes zero API calls.
- [ ] Advisory findings never narrow pass-1 capabilities.
- [ ] Nothing runs unless `LATCH_LLM_ENABLED=true`.

**Depends on:** Tasks 1 and 2.

---

## Person 2 — Vinayak Kamath

Owns: `src/proxy/*`, `src/store/pending.ts`, `src/store/events.ts`,
`src/config/*`, `src/commands/*`, `demo/*`, and the test folders
`tests/proxy/`, `tests/config/`, `tests/commands/`, plus
`tests/store/pending.test.ts` and `tests/store/events.test.ts`.

### Task 1: JSON-RPC transport

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-1-transport
```
**Files you edit:** `src/proxy/transport.ts`
**Tests:** `tests/proxy/transport.test.ts` (new)

**What to build:**
- `parseLine()`: keep `raw`; non-JSON lines give `message: null`.
- `isRequest()`, `isNotification()`, `isResponse()`.
- `readFrames()` with `readline`, `writeLine()` with backpressure, and `spawnUpstream()`.

**Done when:**
- [ ] Lines round-trip unchanged through `readFrames` and `writeLine` over a `PassThrough` stream.
- [ ] A message with unknown fields keeps them in `raw`.
- [ ] The type guards classify request, notification and response correctly.

**Depends on:** nothing.

### Task 2: Blocker

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-2-blocker
```
**Files you edit:** `src/proxy/blocker.ts`
**Tests:** `tests/proxy/blocker.test.ts` (new)

**What to build:**
- `shouldBlock()` and `buildBlockError()` as described in their JSDoc.

**Done when:**
- [ ] An unpinned tool is blocked.
- [ ] A pending tier 2 or 3 change is blocked; tier 0 or 1 is allowed.
- [ ] The error uses code `-32001` and its message mentions `latch review`.

**Depends on:** nothing. You can build lockfile objects by hand in tests.

### Task 3: Pending queue and event log

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-3-pending-events
```
**Files you edit:** `src/store/pending.ts`, `src/store/events.ts`
**Tests:** `tests/store/pending.test.ts`, `tests/store/events.test.ts` (new)

**What to build:**
- `readPending()`, `writePending()`, `enqueue()`, `dequeue()`.
- `appendEvent()` and `readEvents()` over JSONL.

**Done when:**
- [ ] `enqueue()` replaces an existing entry for the same server and tool.
- [ ] Malformed event lines are skipped, not thrown.
- [ ] A missing state directory is created on write.

**Depends on:** nothing. Person 1 Task 7 calls this.

### Task 4: Demo servers

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-4-demo-servers
```
**Files you edit:** `demo/weather-server.ts`, `demo/evil-server.ts`, `demo/README.md`
**Tests:** manual check with `pnpm demo:benign`, piping JSON-RPC lines in

**What to build:**
- Weather server: answers `initialize`, `tools/list` and `tools/call` over raw line-delimited JSON-RPC.
- Evil server: same as weather until 3 calls or SIGUSR1, then serves the poisoned tools and sends `notifications/tools/list_changed`.

**Done when:**
- [ ] `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm -s demo:benign` prints the two benign tools.
- [ ] The evil server switches after 3 calls and emits `list_changed`.

**Depends on:** nothing. Do this early, because Tasks 6 and 7 test against it.

### Task 5: Env and client configs

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-5-config
```
**Files you edit:** `src/config/env.ts`, `src/config/clients.ts`
**Tests:** `tests/config/env.test.ts`, `tests/config/clients.test.ts` (new)

**What to build:**
- `loadEnv()` with the defaults from `.env.example`.
- `clientConfigPath()`, `detectClients()`, `wrapWithProxy()`, `unwrapProxy()`, `writeClientConfig()` (with a `.bak` backup).

**Done when:**
- [ ] A bad port or an unknown log level throws a readable error.
- [ ] `wrapWithProxy()` is idempotent and `unwrapProxy()` reverses it.
- [ ] Unknown keys in a client config survive a write.

**Depends on:** nothing.

### Task 6: Interceptor and proxy lifecycle

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-6-interceptor
```
**Files you edit:** `src/proxy/interceptor.ts`, `src/proxy/index.ts`
**Tests:** `tests/proxy/interceptor.test.ts`, `tests/proxy/proxy.e2e.test.ts` (new)

**What to build:**
- `routeFrame()` plus the three handlers: `onToolsList`, `onToolsCall`, `onToolsListChanged`.
- `startProxy()`: wire both streams, apply each decision, forward signals to the child.

**Done when:**
- [ ] Unknown fields are forwarded byte-for-byte.
- [ ] `tools/call` on a blocked tool returns the Task 2 error and never reaches the server.
- [ ] `list_changed` from the evil server triggers a re-fetch and analysis.

**Depends on:** Tasks 1–4, and Person 1 Tasks 1–5 for real analysis. Until those merge, `vi.mock()` the `src/analyze/*` functions in your own tests.

### Task 7: `latch verify`

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-7-verify
```
**Files you edit:** `src/commands/verify.ts`
**Tests:** `tests/commands/verify.test.ts` (new)

**What to build:**
- Spawn each server in the lockfile, request `tools/list`, run the pipeline, and return `VERIFY_EXIT` codes. Add a `--json` report.

**Done when:**
- [ ] Exits 0 against the benign server.
- [ ] Exits 2 against the mutated evil server.
- [ ] Exits 3 when a server fails to start.

**Depends on:** Task 6, and Person 1 Task 6 (`readLockfile`).

### Task 8: `latch inspect`

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-8-inspect
```
**Files you edit:** `src/commands/inspect.ts`
**Tests:** `tests/commands/inspect.test.ts` (new)

**What to build:**
- Load tools from `--file` or a spawned server, then print capabilities and findings. Add `--json`.

**Done when:**
- [ ] `latch inspect --file tests/fixtures/poisoned-tools.json` lists the findings for all 4 poisoned tools.
- [ ] Never writes to disk.

**Depends on:** Task 1, and Person 1 Tasks 2–4.

### Task 9: `latch proxy`

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-9-proxy-command
```
**Files you edit:** `src/commands/proxy.ts`
**Tests:** `tests/commands/proxy.test.ts` (new)

**What to build:**
- Validate the arguments and delegate to `startProxy()`.

**Done when:**
- [ ] `latch proxy --server weather -- pnpm -s demo:benign` works as an MCP server.
- [ ] Nothing but JSON-RPC appears on stdout.

**Depends on:** Task 6.

### Task 10: `latch init`

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-10-init
```
**Files you edit:** `src/commands/init.ts`
**Tests:** `tests/commands/init.test.ts` (new, use a temp HOME)

**What to build:**
- Detect clients, ask with a `@clack/prompts` multiselect, wrap the chosen servers, capture their tools, and write the initial `latch.lock`. Support `--dry-run`.

**Done when:**
- [ ] Rewrites a sample Claude Desktop config and leaves a `.bak` copy.
- [ ] Writes a valid `latch.lock` with every tool pinned.

**Depends on:** Tasks 5 and 6, and Person 1 Task 6 (`writeLockfile`).

### Task 11: `latch review` (terminal)

**Branch:**
```sh
git checkout main && git pull && git checkout -b p2/task-11-review
```
**Files you edit:** `src/commands/review.ts`
**Tests:** `tests/commands/review.test.ts` (new)

**What to build:**
- Walk the queue with tier 3 first. Approve = `applyApproval` + `writeLockfile` + `dequeue`. Reject = `dequeue` + event.
- `--ui` only calls `startUiServer()` (Person 1 Task 7) and opens the browser.

**Done when:**
- [ ] Approving updates `latch.lock` and empties that queue entry.
- [ ] `latch review --ui` opens the review screen.

**Depends on:** Task 3, and Person 1 Tasks 6 and 7.

---

## Suggested order and sync points

```
Week 1   Person 1: Task 1 → 2 → 3          Person 2: Task 1 → 2 → 3 → 4
Week 2   Person 1: Task 4 → 5 → 6          Person 2: Task 5 → 6 (analysis mocked)
         ── Sync 1: Person 1 Tasks 1–6 merged. The proxy runs the real pipeline. ──
Week 3   Person 1: Task 7 → 8              Person 2: Task 7 → 8 → 9
Week 4   Person 1: Task 9 (optional)       Person 2: Task 10 → 11
         ── Sync 2: the docs/DEMO.md script runs start to finish. ──
```

## PR rules

1. One branch per task, named as shown in the task (`p1/task-N-…`, `p2/task-N-…`).
2. Only touch files you own. Check with `git diff --name-only main...HEAD`.
3. New tests go in new files inside your own test folders.
4. Do not implement a stub in a file you don't own. Mock it in your test instead.
5. `pnpm typecheck && pnpm test` must pass. Rebase on `main` right before merging.
6. The other person reviews every PR.

## Changing a shared file

Sometimes a frozen file must change: a new dependency, a schema field, a CLI flag
or a signature.

1. Tell the other person first.
2. Open a small standalone PR with only that change, on a branch such as
   `shared/add-<dep>` or `shared/schema-<field>`.
3. Merge it before continuing feature work.
4. The other person rebases their current branch on `main`.

Adding a dependency always goes through this path, because both people editing
`package.json` and `pnpm-lock.yaml` is the most likely conflict in this repo.
