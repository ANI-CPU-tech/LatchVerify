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

Every task ends with a **Verify it works** block. A task is not finished until that
block passes: the new tests, the manual check that the feature really works, and the
regression checks for earlier tasks it builds on.

```sh
# 1. run the task's "Verify it works" block and check the expected output
# 2. make sure nothing else broke
pnpm typecheck && pnpm test
git diff --name-only main...HEAD   # every path must be one you own
git push -u origin <your-branch>
# 3. open a PR into main and paste the Verify output under a "## Verify" heading
```

The Verify commands are written for bash or zsh. On fish, run `bash` first.

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

**Verify it works:**
```sh
pnpm vitest run tests/analyze/hash.test.ts
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8")).tools; import { hashTool } from "./src/analyze/hash.ts";
const lock = JSON.parse(readFileSync("latch.lock.example", "utf8"));
for (const r of lock.servers.weather.tools) {
  const t = load("benign-tools.json").find((x: any) => x.name === r.name);
  console.log(r.name, hashTool(t).composite === r.hashes.composite ? "match" : "MISMATCH");
}'
```
Expected: `get_alerts match` and `get_forecast match`.

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

**Verify it works:**
```sh
pnpm vitest run tests/analyze/capabilities.test.ts
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8")).tools; import { extractCapabilities } from "./src/analyze/capabilities.ts";
for (const t of load("poisoned-tools.json")) {
  const { capabilities: c, findings } = extractCapabilities(t, []);
  console.log(t.name, "fs:", c.filesystem.scope, "exec:", c.exec.enabled, "net:", c.network.unconstrained, findings.map((f: any) => f.type));
}'
```
Expected: `read_config fs: unconstrained`, `run_diagnostics exec: true` with an
`annotation_mismatch`, `sync_alerts net: true`.

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

**Verify it works:**
```sh
pnpm vitest run tests/analyze/unicode.test.ts
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8")).tools; import { detectUnicode } from "./src/analyze/unicode.ts";
for (const t of load("poisoned-tools.json")) console.log(t.name, detectUnicode(t.description ?? "", "description").map((f: any) => f.evidence));
for (const t of load("benign-tools.json")) console.log(t.name, detectUnicode(t.description ?? "", "description").length);'
```
Expected: `get_forecast` shows the U+200B run, `run_diagnostics` shows U+202E,
`sync_alerts` shows the decoded tag text `hi`. Both benign tools print `0`.

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

**Verify it works:**
```sh
pnpm vitest run tests/analyze/patterns.test.ts
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8")).tools; import { detectPatterns } from "./src/analyze/patterns.ts";
for (const f of ["poisoned-tools.json", "benign-tools.json"])
  for (const t of load(f)) console.log(f, t.name, detectPatterns(t.description ?? "", "description", { otherServerTools: ["send_email"] }).map((x: any) => `${x.type}: ${x.evidence}`));'
```
Expected: poisoned tools list `you must`, `Do not tell the user`, `Ignore previous`,
`~/.ssh/id_rsa`, `OPENAI_API_KEY` and a `cross_server` hit for `send_email`. Benign
tools print `[]`.

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

**Verify it works:**
```sh
pnpm vitest run tests/analyze/differ.test.ts tests/analyze/tiers.test.ts
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8")).tools;
import { hashTool } from "./src/analyze/hash.ts";
import { extractCapabilities } from "./src/analyze/capabilities.ts";
import { detectUnicode } from "./src/analyze/unicode.ts";
import { detectPatterns } from "./src/analyze/patterns.ts";
import { diffHashes, diffCapabilities } from "./src/analyze/differ.ts";
import { classifyTier } from "./src/analyze/tiers.ts";
const tier = (b: any, a: any) => {
  const ex = extractCapabilities(a, []);
  const findings = [...ex.findings, ...detectUnicode(a.description ?? "", "description"), ...detectPatterns(a.description ?? "", "description", { otherServerTools: [] })];
  return classifyTier(diffHashes(hashTool(b), hashTool(a)), diffCapabilities(extractCapabilities(b, []).capabilities, ex.capabilities), findings);
};
const b = load("benign-tools.json")[0], p = load("poisoned-tools.json")[0];
console.log("poisoned:", tier(b, p));
console.log("reworded:", tier(b, { ...b, description: "Fetch the forecast for a location." }));'
```
Expected: `poisoned: { tier: 3, … }` and `reworded: { tier: 0, … }`.

**Regression:** re-run the Verify blocks of Tasks 1–4.

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

**Verify it works:**
```sh
pnpm vitest run tests/store/lockfile.test.ts
pnpm exec tsx -e 'import { readLockfile, writeLockfile } from "./src/store/lockfile.ts";
readLockfile("latch.lock.example").then((l) => writeLockfile("/tmp/latch-roundtrip.lock", l));'
diff latch.lock.example /tmp/latch-roundtrip.lock && echo identical
pnpm exec tsx -e 'import { readLockfile } from "./src/store/lockfile.ts"; readLockfile("/tmp/does-not-exist.lock").then(console.log);'
```
Expected: `identical`, then an empty lockfile (`servers: {}`).

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

**Verify it works:**
```sh
pnpm vitest run tests/ui/routes.test.ts
pnpm ui                                             # terminal 1
curl -s http://127.0.0.1:7777/api/pending           # terminal 2: JSON array
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7777/api/pending/nope   # 404
ss -ltn | grep 7777                                 # must show 127.0.0.1:7777, not 0.0.0.0
```
To check approve: copy one `change` object from `web/src/lib/mock.ts` into
`.latch/pending.json` (as a JSON array), `cp latch.lock.example latch.lock`, then
`curl -s -X POST -H "X-Latch-Client: review-ui" http://127.0.0.1:7777/api/pending/chg_7f3a91/approve`. Expected:
`git diff --no-index latch.lock.example latch.lock` shows the new `get_forecast`
hashes, and `/api/pending` no longer lists it. Delete `latch.lock` and `.latch/`
afterwards.

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

**Verify it works:**
```sh
pnpm ui
```
Manual check in the browser at http://localhost:5173, with a seeded queue as in Task 7:
- [ ] The list shows the real queue, not the mock (change `.latch/pending.json` and reload).
- [ ] Clicking each list item switches the detail pane.
- [ ] Approve updates `latch.lock` on disk and removes the item. Reject removes it without touching `latch.lock`.
- [ ] Stop the API process: the UI falls back to mock data with a visible notice.
- [ ] Browser devtools at 390 px width: no horizontal page scroll.

**Regression:** re-run the Verify block of Task 7.

### Task 9: LLM advisory pass (optional, last)

**Branch:**
```sh
git checkout main && git pull && git checkout -b p1/task-9-llm
```
**Files you edit:** `src/analyze/llm.ts`, and the `advisory` merge in `src/analyze/capabilities.ts`
**Tests:** `tests/analyze/llm.test.ts` (new, inject a fake `fetch`)

**What to build:**
- `advisoryCacheKey()`.
- `runAdvisory()`: return the cached result on a key match, otherwise call the API at temperature 0 and validate the output with `FindingSchema`.

**Done when:**
- [ ] A cache hit makes zero API calls.
- [ ] Advisory findings never narrow pass-1 capabilities.
- [ ] Nothing runs unless `LATCH_LLM_ENABLED=true`.

**Depends on:** Tasks 1 and 2.

**Verify it works:**
```sh
pnpm vitest run tests/analyze/llm.test.ts
LATCH_LLM_ENABLED=true LATCH_LLM_API_KEY=<your Groq key> pnpm exec tsx -e '
import { readFileSync } from "node:fs"; import { DEFAULT_LLM_MODEL, runAdvisory } from "./src/analyze/llm.ts";
const t = JSON.parse(readFileSync("tests/fixtures/poisoned-tools.json", "utf8")).tools[0];
const opts = { apiKey: process.env.LATCH_LLM_API_KEY!, model: DEFAULT_LLM_MODEL };
runAdvisory(t, opts).then(async (first) => { const second = await runAdvisory(t, opts, first); console.log(first.findings.length, "findings; cached reused:", second === first); });'
```
Expected: at least one finding, and `cached reused: true` (the second call made no
API request). Without the env vars, `latch` must never call the API.

**Regression:** re-run the Verify blocks of Tasks 1, 2 and 5.

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

**Verify it works:**
```sh
pnpm vitest run tests/proxy/transport.test.ts
pnpm exec tsx -e 'import { PassThrough } from "node:stream"; import { readFrames, writeLine } from "./src/proxy/transport.ts";
const i = new PassThrough(), o = new PassThrough(); o.pipe(process.stdout);
readFrames(i, (f) => { console.error("parsed:", f.message !== null); void writeLine(o, f.raw); });
i.end(`{"jsonrpc":"2.0","id":1,"method":"x","x-extra":{"kept":true}}\nnot json\n`);'
```
Expected on stdout: both input lines, byte-for-byte, including `x-extra`. On stderr:
`parsed: true`, then `parsed: false`.

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

**Verify it works:**
```sh
pnpm vitest run tests/proxy/blocker.test.ts
pnpm exec tsx -e 'import { shouldBlock, buildBlockError } from "./src/proxy/blocker.ts";
const lock = { version: "1", generatedAt: new Date().toISOString(), servers: {} };
const v = shouldBlock("weather", "get_forecast", lock, []); console.log(v);
if (v.blocked) console.log(JSON.stringify(buildBlockError(1, "get_forecast", v.reason)));'
```
Expected: `{ blocked: true, reason: { kind: "unpinned" } }`, then an error object with
`"code":-32001` and a message that mentions `latch review`.

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

**Verify it works:**
```sh
pnpm vitest run tests/store/pending.test.ts tests/store/events.test.ts
pnpm exec tsx -e 'import { appendEvent, readEvents } from "./src/store/events.ts";
appendEvent("/tmp/latch-test", { kind: "list_changed", at: new Date().toISOString(), serverId: "weather" }).then(() => readEvents("/tmp/latch-test")).then(console.log);'
echo "garbage" >> /tmp/latch-test/events.jsonl
pnpm exec tsx -e 'import { readEvents } from "./src/store/events.ts"; readEvents("/tmp/latch-test").then(console.log);'
rm -rf /tmp/latch-test
```
Expected: the event is printed both times, and the garbage line is skipped, not thrown.

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
- `DEMO_MUTATE=1` makes the evil server start already mutated, so `latch verify` can be checked against it.

**Done when:**
- [ ] `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm -s demo:benign` prints the two benign tools.
- [ ] The evil server switches after 3 calls and emits `list_changed`.

**Depends on:** nothing. Do this early, because Tasks 6 and 7 test against it.

**Verify it works:**
```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm -s demo:benign
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/list"}' | pnpm -s demo:evil
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | DEMO_MUTATE=1 pnpm -s demo:evil
```
Expected: the benign server lists `get_forecast` and `get_alerts`. The evil server
answers 3 calls, prints a `notifications/tools/list_changed` line, then lists 4 tools
including `read_config`. With `DEMO_MUTATE=1` it serves the poisoned tools straight
away. Only JSON-RPC appears on stdout; logs go to stderr.

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

**Verify it works:**
```sh
pnpm vitest run tests/config/env.test.ts tests/config/clients.test.ts
pnpm exec tsx -e 'import { loadEnv } from "./src/config/env.ts"; console.log(loadEnv());'
LATCH_UI_PORT=abc pnpm exec tsx -e 'import { loadEnv } from "./src/config/env.ts"; loadEnv();'
pnpm exec tsx -e 'import { wrapWithProxy, unwrapProxy } from "./src/config/clients.ts";
const orig = { command: "node", args: ["w.js"], env: { A: "1" }, extra: true };
const once = wrapWithProxy("weather", orig), twice = wrapWithProxy("weather", once);
console.log(JSON.stringify(once) === JSON.stringify(twice), JSON.stringify(unwrapProxy(once)) === JSON.stringify(orig));'
```
Expected: defaults matching `.env.example`; a readable error naming `LATCH_UI_PORT`;
then `true true`.

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

**Verify it works:**
Run in bash. The proxy is fed a session where the evil server rug-pulls after 3 calls.
```sh
pnpm vitest run tests/proxy/interceptor.test.ts tests/proxy/proxy.e2e.test.ts
rm -rf /tmp/latch-state
( printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_alerts","arguments":{"state":"CA"}}}'
  sleep 2
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_forecast","arguments":{"latitude":1,"longitude":2}}}'
  sleep 1 ) | pnpm exec tsx -e 'import { startProxy } from "./src/proxy/index.ts";
startProxy({ serverId: "weather", command: "pnpm", args: ["-s", "demo:evil"], lockfilePath: "latch.lock.example", stateDir: "/tmp/latch-state" }).then((c) => process.exit(c));'
cat /tmp/latch-state/pending.json /tmp/latch-state/events.jsonl
```
Expected:
- [ ] Responses 1–5 come back normally.
- [ ] A `notifications/tools/list_changed` line is forwarded.
- [ ] Response 6 is an **error** with code `-32001` mentioning `latch review`. It never reaches the server.
- [ ] `pending.json` holds a tier-3 `get_forecast` change; `events.jsonl` has `list_changed` and `call_blocked`.

Before Person 1 Tasks 1–5 merge, only the forwarding checks can pass; the tier-3 checks
pass at Sync 1.

**Regression:** re-run the Verify blocks of Tasks 1–4.

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

**Verify it works:**
```sh
pnpm vitest run tests/commands/verify.test.ts
pnpm build
node dist/cli.js --lockfile latch.lock.example verify; echo "exit $?"
sed 's#demo/weather-server.ts#demo/evil-server.ts#' latch.lock.example > /tmp/evil.lock
DEMO_MUTATE=1 node dist/cli.js --lockfile /tmp/evil.lock verify; echo "exit $?"
sed 's#"npx"#"no-such-binary"#' latch.lock.example > /tmp/broken.lock
node dist/cli.js --lockfile /tmp/broken.lock verify; echo "exit $?"
node dist/cli.js --lockfile latch.lock.example verify --json
```
Expected: `exit 0`, then `exit 2` with the tier-3 reasons printed, then `exit 3`, then
a JSON report that parses.

**Regression:** re-run the Verify block of Task 6.

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

**Verify it works:**
```sh
pnpm vitest run tests/commands/inspect.test.ts
pnpm build
node dist/cli.js inspect --file tests/fixtures/poisoned-tools.json
node dist/cli.js inspect --file tests/fixtures/benign-tools.json --json
node dist/cli.js inspect -- pnpm -s demo:benign
git status --short
```
Expected: findings for all 4 poisoned tools; a clean JSON report for the benign file;
the live server gives the same result as its file. `git status` shows nothing new:
inspect never writes.

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

**Verify it works:**
Run in bash.
```sh
pnpm vitest run tests/commands/proxy.test.ts
pnpm build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js --lockfile latch.lock.example --state-dir /tmp/latch-state proxy --server weather -- pnpm -s demo:benign \
| node -e 'require("readline").createInterface({ input: process.stdin }).on("line", (l) => { JSON.parse(l); console.log("ok:", l.slice(0, 60)); })'
```
Expected: two `ok:` lines and no JSON parse error, which proves stdout carries only
JSON-RPC.

Real client check (optional): `claude mcp add weather -- node "$PWD/dist/cli.js" --lockfile "$PWD/latch.lock.example" proxy --server weather -- npx tsx "$PWD/demo/weather-server.ts"`,
then ask Claude Code for a forecast.

**Regression:** re-run the Verify block of Task 6.

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

**Verify it works:**
Run in bash. Uses a throwaway HOME so your real client configs are untouched.
```sh
pnpm vitest run tests/commands/init.test.ts
pnpm build
export FAKE_HOME=$(mktemp -d)
mkdir -p "$FAKE_HOME/.config/Claude"
echo '{"mcpServers":{"weather":{"command":"npx","args":["tsx","'"$PWD"'/demo/weather-server.ts"]}},"other":1}' \
  > "$FAKE_HOME/.config/Claude/claude_desktop_config.json"
HOME=$FAKE_HOME node dist/cli.js --lockfile "$FAKE_HOME/latch.lock" init --client claude-desktop --dry-run
ls "$FAKE_HOME"                                  # no latch.lock yet
HOME=$FAKE_HOME node dist/cli.js --lockfile "$FAKE_HOME/latch.lock" init --client claude-desktop
cat "$FAKE_HOME/.config/Claude/claude_desktop_config.json"; ls "$FAKE_HOME/.config/Claude"
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; import { LockFileSchema } from "./src/schema/index.ts";
console.log(LockFileSchema.parse(JSON.parse(readFileSync(process.env.FAKE_HOME + "/latch.lock", "utf8"))).servers.weather?.tools.length);'
```
Expected: dry run writes nothing. The real run wraps `weather` with `latch proxy`, keeps
`"other":1`, leaves a `.bak` copy, and the lockfile validates with `2` tools. Running
`init` a second time changes nothing (idempotent).

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

**Verify it works:**
```sh
pnpm vitest run tests/commands/review.test.ts
pnpm build
cp latch.lock.example /tmp/review.lock
# seed a tier-3 change: run the Task 6 Verify session with lockfilePath "/tmp/review.lock"
node dist/cli.js --lockfile /tmp/review.lock --state-dir /tmp/latch-state review
git diff --no-index latch.lock.example /tmp/review.lock
cat /tmp/latch-state/pending.json
node dist/cli.js --lockfile /tmp/review.lock --state-dir /tmp/latch-state review --ui
```
Expected: tier-3 `get_forecast` is shown first with its capability delta and findings.
After approving, the diff shows new `get_forecast` hashes and capabilities, and
`pending.json` no longer has it. Rejecting instead leaves `/tmp/review.lock` unchanged.
`--ui` opens the browser on the review screen.

**Regression:** re-run the Verify blocks of Tasks 3 and 6.

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

### Sync 1 check (both people, together)

Run after Person 1 Tasks 1–6 and Person 2 Tasks 1–6 are merged, on a fresh `main`:

- [ ] `pnpm typecheck && pnpm test` passes with no mocks of `src/analyze/*` left in use for the e2e test.
- [ ] Person 2 Task 6 Verify block passes in full: the poisoned `get_forecast` call is blocked with `-32001`, and `pending.json` holds a tier-3 change.
- [ ] Same session with the evil server swapped for the weather server: nothing is blocked and `pending.json` stays empty.
- [ ] A reworded description only (edit `tests/fixtures/benign-tools.json` locally, don't commit) is tier 0 and is not blocked.

### Sync 2 check (both people, together)

Run after every task is merged:

- [ ] Every task's Verify block passes on `main`.
- [ ] `pnpm build` works, then the full [`docs/DEMO.md`](docs/DEMO.md) script runs start to finish: init, commit `latch.lock`, rug pull, proxy blocks, review UI shows "⚠ New capability: filesystem read, unconstrained", `latch verify` exits non-zero.
- [ ] `latch review` approves the change, and `latch verify` then exits 0.

## PR rules

1. One branch per task, named as shown in the task (`p1/task-N-…`, `p2/task-N-…`).
2. Only touch files you own. Check with `git diff --name-only main...HEAD`.
3. New tests go in new files inside your own test folders.
4. Do not implement a stub in a file you don't own. Mock it in your test instead.
5. `pnpm typecheck && pnpm test` must pass. Rebase on `main` right before merging.
6. The other person reviews every PR, and **re-runs the task's Verify block on the
   branch** before approving. A PR without Verify output in its description is not
   ready for review.

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
