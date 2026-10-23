# Person 1 handoff: what Anirudh built

Context for Person 2 (Vinayak Kamath). Everything below is merged into `main`.
All nine Person 1 tasks from [`task_split.md`](task_split.md) are done.

| Task | What | Files | PR |
|---|---|---|---|
| 1 | Segment hashing | `src/analyze/hash.ts` | #1 |
| 2 | Capability extraction (passes 1 and 2) | `src/analyze/capabilities.ts` | #2 |
| 3 | Unicode detector | `src/analyze/unicode.ts` | #3 |
| 4 | Pattern detector | `src/analyze/patterns.ts` | #4 |
| 5 | Differ and tiers | `src/analyze/differ.ts`, `src/analyze/tiers.ts` | #6 |
| 6 | Lockfile store | `src/store/lockfile.ts` | #9 |
| 7 | Review API | `src/ui/routes.ts`, `src/ui/server.ts` | #10 |
| 8 | Web review UI | `web/src/**` | #13 |
| 9 | LLM advisory pass | `src/analyze/llm.ts` | #14 |

Tests live next to each area: `tests/analyze/`, `tests/store/lockfile.test.ts`,
`tests/ui/`, `tests/web/`. Run them all with `pnpm test`.

---

## The analysis pipeline

This is the order the proxy should run for each tool in a `tools/list` reply.
`src/proxy/analysis.ts` already wires most of it.

```ts
const hashes = hashTool(tool);                                   // hash.ts
const { capabilities, findings } = extractCapabilities(tool, otherServerTools, cachedAdvisory); // capabilities.ts
const textFindings = [
  ...detectUnicode(text, field),                                  // unicode.ts
  ...detectPatterns(text, field, { otherServerTools }),           // patterns.ts
]; // for every text field: description, title, and each parameter description
const segments = before ? diffHashes(before.hashes, hashes) : { name: true, description: true, inputSchema: true };
const delta = diffCapabilities(before?.capabilities ?? null, capabilities);   // differ.ts
const decision = classifyTier(segments, delta, [...findings, ...textFindings]); // tiers.ts
isAutoPass(decision.tier); // true for tiers 0 and 1
```

**Pass the text findings into `classifyTier`.** The poisoned `get_forecast` reaches
tier 3 only through its Unicode and pattern findings: its schema change (the added
`notes` parameter) carries no capability signal. If only the capability delta is
passed, the rug pull is classified tier 0.

---

## Module guide

### `src/analyze/hash.ts`
- `hashTool(tool)` gives `{ name, description, inputSchema, composite }` as SHA-256 hex.
  It reproduces every hash in `latch.lock.example`.
- `canonicalJson(value)` sorts keys (RFC 8785 order), so reordering a schema's keys
  doesn't change its hash.
- `sha256Hex(text)` hashes text as UTF-8 with no Unicode normalization, so one
  zero-width character changes the hash.
- Only name, description and inputSchema are hashed. `title`, `outputSchema` and
  vendor fields are not.
- **Throws** `TypeError` or `RangeError` on values JSON can't hold, cycles, or
  nesting deeper than `MAX_CANONICAL_DEPTH` (256).

### `src/analyze/capabilities.ts`
- `extractCapabilities(tool, knownTools, advisory?)` returns
  `{ capabilities, findings }` and is the main entry point.
- Pass 1, `deriveFromSchema`, matches parameter names against `PARAM_SIGNALS`:
  - `enum`, `const` or an anchored `pattern` make the access constrained;
  - a bare string makes it unconstrained;
  - URL and hostname formats count as network access whatever the parameter is called.
- Pass 2: annotations are stored as claims under `declared`. A claim may widen the
  set but never narrows it: `openWorldHint: true` adds network egress. A contradiction
  becomes a `warn` `annotation_mismatch` finding.
- `crossServerRefs` is filled from `knownTools` names found anywhere in the tool's
  text, including parameter descriptions.
- **Throws** `RangeError` on absurdly deep or exponentially expanding `$ref` schemas.
- Helpers also used elsewhere: `foldText` (NFKC plus removing invisible characters)
  and `findToolMentions`.

### `src/analyze/unicode.ts`
- `detectUnicode(text, field)` returns `unicode` findings.
- **critical:** tag characters (the evidence shows the decoded payload), bidi
  openers, and two or more variation selectors in a row.
- **warn:** zero-width or other invisible characters, control characters (terminal
  escapes), and look-alike words.
- Normal emoji (❤️, family emoji, skin tones), keycaps and Persian or Indic joiners
  are deliberately **not** reported.
- `escapeForEvidence(text)` renders any text as quoted printable ASCII. Use it for
  any evidence built from untrusted text; `blocker.ts` already does.

### `src/analyze/patterns.ts`
- `detectPatterns(text, field, { otherServerTools })` returns `pattern` and
  `cross_server` findings.
- **critical:**
  - concealment ("do not tell the user") and instruction overrides ("ignore previous");
  - any other imperative phrase when the same text names a sensitive file;
  - sensitive paths: `~/.ssh`, `id_rsa`, cloud credentials, `/etc/passwd`, MCP client configs;
  - secret-like environment variable names (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`);
  - another server's tool name.
- **warn:** other imperatives ("you must"), other absolute paths, other environment
  variables. `PRIMARY_KEY` and `NEXT_TOKEN` are not treated as secrets.
- `otherServerTools` must hold **only** tools on other servers. A server's own tool
  names would flag themselves.

### `src/analyze/differ.ts` and `src/analyze/tiers.ts`
- `diffCapabilities(before | null, after)` returns dotted keys:
  - **gained / lost:** `filesystem.read`, `exec.shell`, `crossServerRefs:send_email`, and so on;
  - **loosened:** `filesystem.scope` widening, `network.unconstrained` turning on, and
    entries added to a pinned allow-list (`filesystem.paths:...`, `network.domains:...`).
  - `null` means a new tool, which is compared with the empty set.
- `classifyTier(segments, delta, findings)` applies these rules; the first match wins:
  - an **unchanged definition is tier 0 whatever its findings**, so there's no phantom
    drift after a detector update;
  - 3: a critical `unicode`, `pattern` or `cross_server` finding, or a gained exec,
    credential or cross-server key;
  - 2: any other gain or loosening;
  - 1: narrowing only;
  - 0: a text change with identical capabilities.
- `annotation_mismatch` and `warn` findings never raise the tier on their own.
- `diffDescription(before, after)` is a word-level diff for the UI. It falls back to
  "replace all" for edits over 500 tokens.

### `src/analyze/llm.ts` (optional, off by default)
- `runAdvisory(tool, { apiKey, model, baseUrl? }, cached?)` works with any
  OpenAI-compatible API. It defaults to Groq (`DEFAULT_LLM_BASE_URL`,
  `DEFAULT_LLM_MODEL`); OpenRouter works with `baseUrl: "https://openrouter.ai/api/v1"`.
- A cached advisory whose `contentHash` matches is returned with **no API call**.
  Store the result on the `ToolRecord.advisory` in `latch.lock`.
- Findings are **capped at `warn`**, so an LLM can never block a tool.
- **Throws** `LlmError` (missing key, timeout, HTTP error, unusable reply). The API key
  never appears in error messages.
- Call it only when `LATCH_LLM_ENABLED=true`.

### `src/store/lockfile.ts`
- `readLockfile(path)`: a missing file gives `emptyLockfile()`. A corrupt,
  schema-invalid or newer-version file **throws `LockfileError`** and is never
  treated as empty.
- `writeLockfile(path, lock)` validates first, then writes atomically (temp file,
  fsync, rename). The output is byte-stable through `serializeLockfile`.
- `findRecord(lock, serverId, toolName)` looks up a pinned record.
- `applyApproval(lock, change, approvedBy, now)` is pure and returns a new lockfile.
  It **refuses a server that isn't already in the lockfile**, because a pending change
  doesn't say how to launch the server, so `latch init` must add servers first. It
  also refuses a blank approver, an invalid date, or a record for a different tool.

### `src/ui/routes.ts` and `src/ui/server.ts` (review API)
- `GET /api/pending` (highest tier first, then oldest), `GET /api/pending/:id`,
  `GET /api/events?limit=`, `GET /api/lockfile`.
- `POST /api/pending/:id/approve` writes latch.lock **before** dequeuing, so a crash in
  between is safe to retry. `POST .../reject` returns 204 and leaves latch.lock untouched.
- **Request guard:** the Host must be localhost, which blocks DNS rebinding. Every
  POST needs the **`X-Latch-Client`** header (`CLIENT_HEADER`) and no foreign `Origin`.
  The terminal `latch review` doesn't go through HTTP; anything else that POSTs must
  send the header.
- Approve and reject are serialized **within one process**. If the proxy and the
  review server write `.latch/pending.json` at the same moment, one write can be lost;
  cross-process locking would belong in `store/pending.ts`.
- `startUiServer({ port, lockfilePath, stateDir, reviewer, staticDir? })` binds
  `127.0.0.1` only and returns `{ url, close }`.
  - With `staticDir` it serves the built UI (`vite build` goes to `dist/web`).
  - `defaultReviewer()` returns `LATCH_REVIEWER`, else `git config user.email`, else
    the OS user name.
  - `latch review --ui` can call it directly.

### `web/` (review screen)
- Loads the live queue. It falls back to sample data, with a notice, **only** when the
  API is unreachable (network error, 502–504, or a non-JSON reply).
- Approve and Reject call the API with `X-Latch-Client`. A tier-3 approval needs a
  second, confirming click.
- Live changes have no description text (see the follow-ups), so the UI shows which
  segments changed (name, description, input schema) instead of a text diff.

---

## Decisions that differ from the original stubs

| Stub said | Built | Why |
|---|---|---|
| every absolute path is critical | only sensitive files are critical; other paths are warn | critical means tier 3; a tool that reads `/var/log` would have been blocked |
| imperatives are warn, critical with a sensitive path | concealment and override phrases are always critical | no honest tool says "do not tell the user" |
| `*_KEY` is critical | except data-structure and pagination keys (`PRIMARY_KEY`, `NEXT_TOKEN`) | would block database tools |
| annotations are claims only | a claim can widen, never narrow (`openWorldHint` adds egress) | gives the benign weather tools their real network egress |
| Anthropic SDK for the LLM pass | OpenAI-compatible `fetch` (Groq or OpenRouter) | the project uses free API keys |

---

## Open follow-ups (shared files: do them together)

1. ~~**LLM env vars**~~ done (branch `fix/integration-audit`): `LATCH_LLM_API_KEY`,
   `LATCH_LLM_BASE_URL`, `LATCH_LLM_MODEL`, loaded from `.env` by the CLI.
2. ~~**Unused dependency**~~ done: `@anthropic-ai/sdk` removed.
3. ~~**Outdated Verify blocks in `task_split.md`**~~ done: Task 7's `curl` sends
   `X-Latch-Client`, Task 9 uses the OpenAI-compatible API.
4. ~~**`latch.lock.example` domains**~~ done: capabilities regenerated with
   `extractCapabilities` (`domains: []`); a test keeps them in sync.
5. **Description text isn't in the pending queue.** `PendingChange` stores hashes only,
   so the UI can't show a text diff for live changes. Adding the text is a shared
   schema change.
6. **`outputSchema` isn't hashed or checked.** A server could change it unnoticed.
   (`title` and `annotations` are now pinned in the `metadata` hash segment.)

---

## Verify

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm ui        # API on 127.0.0.1:7777, UI on http://localhost:5173
```

Each task's "Verify it works" block in `task_split.md` still applies. Run the Sync 1 and Sync 2 checklists together once the proxy and
commands are in.
