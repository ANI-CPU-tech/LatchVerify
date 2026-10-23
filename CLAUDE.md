# CLAUDE.md

Context for Claude Code sessions working on LatchVerify.

## What this is

LatchVerify (`latchverify` on npm, CLI `latch`) is a stdio security proxy for MCP
servers. It derives a structured capability set from each tool definition, pins it
in a git-committed `latch.lock`, and blocks `tools/call` when a tool gains
capabilities without review. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Current phase: implemented

Every module is implemented and tested; the scaffold phase is over. Fix bugs with
a regression test first.

- **`src/schema/` is the shared contract.** Change it deliberately: every module,
  `tests/schema.test.ts`, `web/src/lib/mock.ts` and `latch.lock.example` depend
  on its shape.
- `latch.lock.example` holds real hashes and capabilities; tests check both.
- The review UI reads the hono API and falls back to `web/src/lib/mock.ts` when the
  API is unreachable.

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
| Optional LLM pass | any OpenAI-compatible chat-completions API via `fetch` (Groq, OpenRouter); no SDK |

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
  `pending.ts`, `event.ts`, re-exported from `index.ts`).
- Proxy: `src/proxy/` (`transport.ts` framing, `interceptor.ts` the three
  interception points, `blocker.ts` verdict and error).
- Analysis pipeline: `src/analyze/` (hash, capabilities, unicode, patterns,
  differ, tiers, llm).
- State: `src/store/` (`lockfile.ts` for `latch.lock`; `pending.ts` and
  `events.ts` for `.latch/`).
- CLI: `src/cli.ts` wires `src/commands/*`.
- Review UI: `src/ui/` (hono API, loopback only) and `web/` (Vite app). See
  "Review UI" below.
- Fixtures: `tests/fixtures/benign-tools.json` and `poisoned-tools.json`, which
  the demo servers also serve.

## Review UI

**API** (`src/ui/routes.ts`): `GET /api/pending`, `GET /api/pending/:id`,
`POST /api/pending/:id/approve|reject`, `GET /api/events?limit=`, `GET /api/lockfile`,
`GET /api/lockfile/git` (read-only `git status`/`git log` of `latch.lock`, in
`src/ui/git.ts`). It answers only on loopback hosts; writes need the
`X-Latch-Client` header and a loopback `Origin`. Do not loosen these guards.

`pnpm ui` runs `scripts/dev-ui.ts`, which also mounts the **development-only build API**
(`/api/build/*`, `scripts/package/routes.ts`) behind the same guard through
`startUiServer({ extend })`. `latch review --ui` never mounts it, so the shipped CLI cannot
run builds; the Build & Distribution page then says it needs a source checkout.

**Web** (`web/src`):
- `App.tsx` routes by hash (`lib/router.ts` parses, `lib/useRoute.ts` follows `hashchange`: `#/review/<id>`, `#/tools/<server>`, ...)
  so the same bundle works under Vite and under `latch review --ui`.
- `lib/data.tsx` loads the queue, lockfile, events and git status once and shares them
  with every page. It polls every 3 s while the API is connected. Refresh, or a decision,
  reloads all four.
- `lib/api.ts` validates every response with the shared zod schemas
  (`src/schema/event.ts` holds the event log schema for this reason).
- `lib/format.ts` holds the pure view logic (plain-language explanations, server
  summaries). Keep logic there, not in components, so `tests/web/` can test it in node.
- `pages/` holds one file per sidebar entry. `components/ui.tsx` holds the shared pieces
  (Panel, Badge, Tabs, Terminal, buttonClass), and `components/icons.tsx` holds inline SVG
  icons (no icon dependency).

**Security boundaries.** The UI displays tiers and decisions; the proxy and the API
decide. There are no client-side security checks, no invented data, and nothing is
sent off the machine (no remote fonts or scripts). Sample data (`lib/mock.ts`) appears
only on the Review Queue, only when the API is unreachable, labeled, with actions
disabled. No page shows live connection state, because nothing reports it: Servers
shows the last `tools_listed` event instead.

**Themes.** Every color is a CSS variable in `web/src/index.css`, one block per
`[data-theme]`. `tailwind.config.ts` maps the variables to classes (`bg-card`,
`text-primary`, `bg-terminal`, ...). Use those classes and never hardcode colors.
- To add a theme: add a token block to `index.css`, an entry to `web/src/lib/themes.ts`,
  and the id to the boot script in `web/index.html`, which applies the theme before
  first paint.
- `tests/web/themes.test.ts` fails if a theme misses a token, if a text pair drops below
  WCAG AA 4.5:1, or if the boot script drifts from the registry.
- `primary` is the AA-safe color for text and buttons. `accent` is the brand orange and
  is for decoration only.
- The preference ("system" or a theme id) is stored in `localStorage` under
  `latch.theme`, with every access wrapped in try/catch.

**Artwork.** `web/src/art/landscape.ts` generates an original pixel-art landscape: sun,
two mountain ranges with snow, pines and birds. It comes in two scenes, `wide` for the
Overview header and `tall` for the bottom of the sidebar, which hides on short windows.
`PixelLandscape.tsx` draws it as inline SVG with `crispEdges`, colored by the `--art-*` tokens
of each theme; Minimal uses muted greys. The art is decorative only: `aria-hidden`,
`pointer-events-none`, and never placed over content. The app icon is a 16x16 grid in
`scripts/package/icon.ts`, rendered to PNG/ICO/SVG for packages and to
`web/public/favicon.svg`, which a test keeps in sync.

## Packaging (scripts/package, packaging/)

Run `pnpm package <target> --version x.y.z`, or use the Build & Distribution page. Read
`packaging/README.md` first.
- Every package holds the same architecture-independent app: dist, the web UI, and
  production `node_modules` installed offline and hoisted from the pnpm store. It needs
  Node 22+ at run time.
- Targets:
  - `linux-tarball`, `windows-zip` and `arch` build and verify on this CachyOS machine.
  - `deb` needs `dpkg-deb`.
  - `flatpak` needs flatpak-builder plus the freedesktop 24.08 runtime, SDK and node22
    extension. It is a local bundle, not Flathub (see `packaging/flatpak/FLATHUB.md`).
  - `windows-installer` (Inno Setup) builds only on Windows or through
    `.github/workflows/package.yml` (run by hand, or by release.yml on a `v*` tag).
- Templates in `packaging/` use `@NAME@` placeholders. `config.ts render()` throws on a
  missing or unused value.
- Launchers: `packaging/linux/latchverify-review` (POSIX sh) and `LatchVerify Review.cmd`
  run `latch review --ui`. They ask for the project directory when started from a menu.

Packaging rules:
- The API and CLI take only `{target, version, arch}`, validated by
  `src/schema/build.ts`.
- Every command runs with `shell: false`, with fixed arguments and an allowlisted
  environment (`process.ts buildEnv`).
- `assertCleanTree` refuses `.env`, keys, `.npmrc`, `latch.lock` and `.latch` in a package.
- A job succeeds only if every prerequisite, validation and verification check passes, and
  only then are artifacts listed or downloadable.
- Output goes to the gitignored `build/packages/<version>/<target>/`, with SHA256SUMS,
  INSTALL.md and build.json. Job records are in `build/packages/.jobs/`.
- "Prepare release" writes RELEASE_NOTES.md and SHA256SUMS after re-hashing every file.
- Nothing in scripts/package pushes, uploads, tags or publishes; keep it that way.
  Publishing happens only in `.github/workflows/release.yml`, on a pushed `v*` tag.

Signing and releases (see `packaging/RELEASING.md`):
- Windows installer (`scripts/package/signing.ts`): Authenticode through signtool. Inno
  Setup signs the installer and its uninstaller.
  - Configure with `LATCH_WIN_SIGN_THUMBPRINT`, or `LATCH_WIN_SIGN_DLIB` +
    `LATCH_WIN_SIGN_METADATA` for Azure Artifact Signing.
  - Verified with `signtool verify /pa /all`. `LATCH_WIN_SIGN_REQUIRED=1` fails an
    unsigned build.
  - Smart App Control needs a CA-issued or Azure-issued certificate. Self-signed never works.
- `scripts/package/release.ts` assembles `release/`: every package once, SHA256SUMS, and
  SHA256SUMS.asc when `LATCH_GPG_KEY_ID` is set, plus RELEASE_NOTES.md.
- CI:
  - `package.yml` (reusable) builds on Ubuntu, an Arch container, Ubuntu with Flatpak, and
    Windows.
  - Arch and Flatpak package the Ubuntu job's archive through `LATCH_PORTABLE_TARBALL`.
  - `release.yml` attests provenance and runs `gh release create`.
  - Workflow scripts take values only through `env`; `tests/package/workflows.test.ts`
    forbids `${{ }}` inside `run:`.


## Build order (as built)

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
pnpm build      # CLI into dist/, web UI into dist/web (latch review --ui)
pnpm ui         # API (+ dev build API) on 7777, Vite on 5173; set LATCH_LOCKFILE_PATH / LATCH_STATE_DIR
pnpm package --list                     # packaging targets and missing tools
pnpm package arch --version 0.1.0       # build + verify one package
pnpm package --release 0.1.0            # release notes + checksums (local files only)
```

There is no browser test runner. To check the UI visually, serve the built bundle and use
`firefox --headless --screenshot`.

## Remaining work

- CI results are not stored, so the Git & CI page documents `latch verify` rather than
  showing CI runs, and no page shows live proxy connections.
- The release pipeline has not run end to end. The Arch container, Flatpak and Windows
  signing jobs need a pushed tag and configured secrets to be exercised.
- Windows signing needs a real certificate (Azure Artifact Signing or a CA-issued PFX).
- The `.deb` and pacman packages are not individually signed; integrity comes from the
  signed SHA256SUMS and provenance attestations.
- There is no AppImage, because it would need a downloaded Node runtime and appimagetool.
- Flathub submission needs a source-built manifest with generated npm sources and an app id
  matching a repository you own (`packaging/flatpak/FLATHUB.md`).
- On Windows, MCP clients that spawn `latch` without a shell may not resolve `latch.cmd`.
