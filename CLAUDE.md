# CLAUDE.md

Context for Claude Code sessions working on LatchVerify.

## What this is

LatchVerify (`latchverify` on npm, CLI `latch`) is a stdio security proxy for MCP
servers. It derives a structured capability set from each tool definition, pins it
in a git-committed `latch.lock`, and blocks `tools/call` when a tool gains
capabilities without review. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Current phase: scaffold only

The repository is a scaffold. Until the user says the scaffold phase is over:

- **Do not implement logic.** Functions keep their full typed signatures, a
  `// TODO:` or JSDoc `TODO:` saying what they will do and return, and
  `throw new Error("not implemented");`.
- **The one exception is `src/schema/`.** The zod schemas there are complete and
  everything else mocks against them. Change them deliberately: every module,
  `tests/schema.test.ts`, `web/src/lib/mock.ts` and `latch.lock.example` depend
  on their shape.
- React components render static markup from `web/src/lib/mock.ts`.

When implementation starts, follow the build order below and replace stubs one
module at a time, with tests.

## Stack (fixed, do not substitute)

| Layer | Choice |
|---|---|
| Runtime | Node 22+ (ESM, `"type": "module"`) |
| Language | TypeScript, `strict`, `NodeNext` modules |
| Validation | `zod` v4 (`z.looseObject`, `z.iso.datetime()`) |
| CLI | `commander`, `@clack/prompts`, `picocolors` |
| UI server | `hono` + `@hono/node-server` |
| Frontend | Vite + React 18 + Tailwind 3, shadcn/ui conventions (hand-written, no shadcn CLI) |
| Diff | `diff` (jsdiff) |
| Tests | `vitest` |
| Package manager | `pnpm` (single package, no workspaces; `pnpm-workspace.yaml` only holds pnpm 11 settings) |
| Optional LLM pass | `@anthropic-ai/sdk` |

## Hard rules

- **No MCP SDK.** The proxy parses raw line-delimited JSON-RPC with `readline` and
  spawns the server with `child_process.spawn`. A transparent proxy must forward
  fields it does not model, and SDKs normalize them away. Forward untouched frames
  byte-for-byte (`Frame.raw`), and re-serialize only messages the proxy rewrites.
- **stdout is the protocol.** In proxy mode nothing but JSON-RPC may go to stdout.
  Logs go to stderr and `.latch/events.jsonl`.
- **Blocks are JSON-RPC errors.** A blocked `tools/call` gets an error response
  (code `-32001`) whose message the model can read and relay ("blocked pending
  review — run `latch review`"). Never drop or hang the request.
- **Relative imports inside `src/`** with `.js` extensions. The `@schema/*` alias is
  for `web/` only: `tsc` does not rewrite aliases in emitted JS.
- **`latch.lock` is committed.** Only `.latch/` is gitignored.
- **Annotations are claims.** `readOnlyHint`, `destructiveHint` and `openWorldHint`
  go in `capabilities.declared` and never override derived capabilities.

## Tier system

| Tier | Trigger | Action |
|---|---|---|
| 0 | Text changed, capability set identical | Auto-pass, log |
| 1 | Capability narrowed or constraint added | Auto-pass, log |
| 2 | Capability gained or constraint loosened | Block, queue for review |
| 3 | Hidden-instruction pattern, Unicode obfuscation, cross-server ref, exec or credential gain | Hard block, alert |

Tier 0 auto-pass is mandatory. Descriptions change on every release, and a tool
that blocks on every reword gets disabled by its users.

## Where things live

- **Keystone schema:** `src/schema/` (`capability.ts`, `tool.ts`, `lockfile.ts`,
  `pending.ts`, re-exported from `index.ts`).
- Proxy: `src/proxy/` (`transport.ts` framing, `interceptor.ts` the three
  interception points, `blocker.ts` verdict and error).
- Analysis pipeline: `src/analyze/` (hash, capabilities, unicode, patterns,
  differ, tiers, llm).
- State: `src/store/` (`lockfile.ts` for `latch.lock`; `pending.ts` and
  `events.ts` for `.latch/`).
- CLI: `src/cli.ts` wires `src/commands/*`.
- Review UI: `src/ui/` (hono API, loopback only) and `web/` (Vite app).
- Fixtures: `tests/fixtures/benign-tools.json` and `poisoned-tools.json`, which
  the demo servers also serve.

## Build order

1. `analyze/hash.ts` (canonical JSON, segment hashes) and `store/lockfile.ts`
   (read, write with stable sorting, approve). Test the round trip against
   `latch.lock.example`.
2. `analyze/capabilities.ts` pass 1 (schema signals) and pass 2 (annotation
   claims and mismatch findings). Test against both fixtures.
3. `analyze/differ.ts` and `analyze/tiers.ts`. Benign→poisoned fixture must land
   at tier 3; a reworded description must land at tier 0.
4. `analyze/unicode.ts` and `analyze/patterns.ts`.
5. `proxy/transport.ts`, then `proxy/blocker.ts`, then `proxy/interceptor.ts` and
   `proxy/index.ts`. Integration-test with `demo/evil-server.ts`.
6. `store/pending.ts`, `store/events.ts`.
7. Commands: `verify` (the CI contract), then `inspect`, `init`, `review`.
8. `ui/` routes and wiring `web/` to `lib/api.ts`.
9. `analyze/llm.ts` last. It is optional and off by default.

## Commands

```sh
pnpm typecheck   # must stay at zero errors
pnpm test
pnpm build
pnpm ui
```
