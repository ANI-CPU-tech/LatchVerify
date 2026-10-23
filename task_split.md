# Task split

Two people implement the LatchVerify scaffold in parallel.

| | Name | Area |
|---|---|---|
| **Person 1** | Anirudh Rao | Analysis engine, lockfile store, review UI |
| **Person 2** | Vinayak Kamath | Proxy runtime, local state, config, CLI commands, demo |

## The one rule: split by file, not by feature

Every file has **exactly one owner**. A PR only touches files its author owns. Two
PRs then never edit the same file, so they cannot conflict.

Code that crosses the boundary goes through the typed stub signatures that are
already committed. Example: `proxy/interceptor.ts` (Vinayak) calls `hashTool()`,
`extractCapabilities()`, `diffCapabilities()` and `classifyTier()` (Anirudh). Vinayak
codes against those signatures as they are today. **Do not change a function
signature in a file you own** without the shared-change process below.

## Ownership

### Person 1: Anirudh Rao

| Path | Notes |
|---|---|
| `src/analyze/hash.ts` | canonical JSON, segment hashes |
| `src/analyze/capabilities.ts` | pass 1 (schema signals), pass 2 (annotation claims) |
| `src/analyze/unicode.ts` | zero-width, bidi, tag chars, confusables |
| `src/analyze/patterns.ts` | imperative phrases, paths, env vars, cross-server refs |
| `src/analyze/differ.ts` | hash diff, capability delta, description diff |
| `src/analyze/tiers.ts` | tier 0–3 classification |
| `src/analyze/llm.ts` | optional advisory pass |
| `src/store/lockfile.ts` | read, write, find, approve |
| `src/ui/routes.ts`, `src/ui/server.ts` | hono review API |
| `web/**` | React review UI |
| `tests/fixtures/*` | owner; Vinayak reads them, never edits |
| `tests/analyze/*.test.ts`, `tests/store/lockfile.test.ts`, `tests/ui/*.test.ts` | new test files |

### Person 2: Vinayak Kamath

| Path | Notes |
|---|---|
| `src/proxy/transport.ts` | line framing, spawn, type guards |
| `src/proxy/blocker.ts` | block verdict, JSON-RPC error |
| `src/proxy/interceptor.ts` | the three interception points |
| `src/proxy/index.ts` | `startProxy` lifecycle |
| `src/store/pending.ts`, `src/store/events.ts` | `.latch/` queue and event log |
| `src/config/env.ts`, `src/config/clients.ts` | env loading, client config detection and rewriting |
| `src/commands/*.ts` | init, review, verify, inspect, proxy |
| `demo/weather-server.ts`, `demo/evil-server.ts`, `demo/README.md` | demo servers |
| `tests/proxy/*.test.ts`, `tests/store/pending.test.ts`, `tests/store/events.test.ts`, `tests/config/*.test.ts`, `tests/commands/*.test.ts` | new test files |

### Shared and frozen (nobody edits these in a feature PR)

```
src/schema/*            src/cli.ts              src/index.ts
package.json            pnpm-lock.yaml          pnpm-workspace.yaml
tsconfig.json           tsconfig.build.json     vitest.config.ts
.env.example            .gitignore              .npmrc
latch.lock.example      tests/schema.test.ts
README.md               CLAUDE.md               docs/*        task_split.md
```

These files are the contract between the two halves. See
[Changing a shared file](#changing-a-shared-file).

## Person 1 tasks (Anirudh)

Ordered by what Vinayak needs first.

| # | Task | Files | Done when |
|---|---|---|---|
| A1 | Segment hashing | `analyze/hash.ts` | `hashTool()` reproduces the hashes in `latch.lock.example` for the benign fixture; reordering `inputSchema` keys gives the same hash; one inserted U+200B changes `description` |
| A2 | Capability extraction, passes 1 and 2 | `analyze/capabilities.ts` | benign fixture → network egress only; poisoned `read_config` → `filesystem.read`, unconstrained; `run_diagnostics` → `exec.enabled`; `readOnlyHint` + exec gives an `annotation_mismatch` finding |
| A3 | Unicode detector | `analyze/unicode.ts` | flags the U+200B run, U+202E and the tag chars in the poisoned fixture; `decodeTagChars` returns `"hi"`; benign fixture → no findings |
| A4 | Pattern detector | `analyze/patterns.ts` | flags `you must`, `Do not tell the user`, `~/.ssh/id_rsa`, `OPENAI_API_KEY`, and `send_email` as a cross-server ref |
| A5 | Differ and tiers | `analyze/differ.ts`, `analyze/tiers.ts` | benign → poisoned `get_forecast` = tier 3; reworded description with identical capabilities = tier 0; `enum` → bare `string` = tier 2 |
| A6 | Lockfile store | `store/lockfile.ts` | round trip of `latch.lock.example` is byte-identical; output sorted; missing file → empty lockfile; `applyApproval` is pure |
| A7 | Review API | `ui/routes.ts`, `ui/server.ts` | routes return real data from `.latch/` and `latch.lock`; server binds 127.0.0.1 only; tested with `app.request()` |
| A8 | Wire the web UI | `web/src/**` | `fetchPending`, `approveChange`, `rejectChange` implemented; selection state; Approve/Reject buttons work; mock only used as a fallback |
| A9 | LLM advisory pass (optional, last) | `analyze/llm.ts` | cache hit makes no API call; temperature 0; output validated with `FindingSchema` |

A7 and A8 call `readPending()` and `readEvents()` (Vinayak, V3). Code against the
signatures; they work end to end once V3 lands.

## Person 2 tasks (Vinayak)

| # | Task | Files | Done when |
|---|---|---|---|
| V1 | JSON-RPC transport | `proxy/transport.ts` | `parseLine` keeps `raw` and tolerates non-JSON; type guards correct; `readFrames` + `writeLine` round-trip lines through a `PassThrough` stream |
| V2 | Blocker | `proxy/blocker.ts` | unpinned → blocked; pending tier 2/3 → blocked; tier 0/1 → allowed; error uses code `-32001` and mentions `latch review` |
| V3 | Pending queue and event log | `store/pending.ts`, `store/events.ts` | `enqueue` replaces same server/tool; `dequeue` by id; events append as JSONL; malformed lines skipped |
| V4 | Env and client configs | `config/env.ts`, `config/clients.ts` | defaults match `.env.example`; bad port throws; `wrapWithProxy` is idempotent and `unwrapProxy` reverses it; unknown keys preserved |
| V5 | Interceptor and proxy lifecycle | `proxy/interceptor.ts`, `proxy/index.ts` | unknown fields forwarded byte-for-byte; `tools/call` blocked per V2; `list_changed` triggers a re-fetch; SIGTERM forwarded to the child. Full analysis results need A1–A5 |
| V6 | Demo servers | `demo/*.ts` | weather server answers `initialize`, `tools/list`, `tools/call`; evil server mutates after 3 calls or SIGUSR1 and emits `list_changed`. **Do this early:** V5 and V7 test against it |
| V7 | `latch verify` | `commands/verify.ts` | exit codes 0/1/2/3 per `docs/LOCKFILE.md`; `--json` report; green against benign, exit 2 against mutated evil server |
| V8 | `latch inspect` | `commands/inspect.ts` | `--file tests/fixtures/poisoned-tools.json` prints capabilities and findings; never writes |
| V9 | `latch proxy` | `commands/proxy.ts` | delegates to `startProxy`; nothing but JSON-RPC on stdout |
| V10 | `latch init` | `commands/init.ts` | detects clients, `@clack/prompts` multiselect, backs up config, writes initial `latch.lock` (uses A6 `writeLockfile`) |
| V11 | `latch review` (terminal) | `commands/review.ts` | walks the queue tier 3 first; approve = `applyApproval` + `writeLockfile` + `dequeue`; `--ui` only calls `startUiServer` (A7) |

## Suggested order and sync points

```
Week 1   Anirudh: A1 → A2 → A3            Vinayak: V1 → V2 → V3 → V6
Week 2   Anirudh: A4 → A5 → A6            Vinayak: V4 → V5 (analysis mocked in tests)
         ── Sync 1: A1–A6 merged. V5 runs the real pipeline end to end. ──
Week 3   Anirudh: A7 → A8                 Vinayak: V7 → V8 → V9
Week 4   Anirudh: A9 (optional)           Vinayak: V10 → V11
         ── Sync 2: full docs/DEMO.md script runs start to finish. ──
```

Until Sync 1, Vinayak's tests mock Anirudh's functions with `vi.mock()` in his own
test files. No edits to `src/analyze/` are needed for that.

## PR rules

1. **One branch per task:** `anirudh/a3-unicode`, `vinayak/v2-blocker`, and so on.
2. **Only touch files you own.** Before opening a PR, check with
   `git diff --name-only main...HEAD`.
3. **New tests go in new files** inside your own test folders. Never edit the
   other person's test files or `tests/schema.test.ts`.
4. **Keep stubs elsewhere as stubs.** Don't "quickly implement" a helper in a file
   you don't own. Ask the owner, or mock it in your test.
5. **Before every PR:** `pnpm typecheck && pnpm test` must pass. Rebase on `main`
   right before merging.
6. **Review:** the other person reviews each PR. That is also how each of you learns
   the other half of the codebase.

## Changing a shared file

Sometimes a frozen file must change: adding a dependency, a schema field, a CLI flag
or a new signature.

1. Tell the other person first (chat or an issue).
2. Open a **small standalone PR** with only that change, for example
   `shared/add-execa-dep` or `shared/schema-add-field`.
3. Merge it quickly, before continuing feature work.
4. The other person rebases their branch on `main`.

Adding a dependency always goes through this path, because both people editing
`package.json` and `pnpm-lock.yaml` is the most likely conflict in this repo.
