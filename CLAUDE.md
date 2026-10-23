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
`src/ui/git.ts`), `POST /api/simulate` (a rug pull rehearsed in memory by
`src/ui/simulation.ts` with the proxy's own analyzeToolList, applyApproval, shouldBlock and
buildBlockError; it reads and writes no file, body capped at 1 MiB). It answers only on
loopback hosts; writes, and every POST, need the `X-Latch-Client` header and a loopback
`Origin`. Do not loosen these guards.

**Web** (`web/src`):
- `App.tsx` routes by hash (`lib/router.ts` parses, `lib/useRoute.ts` follows `hashchange`: `#/review/<id>`, `#/tools/<server>`, ...)
  so the same bundle works under Vite and under `latch review --ui`.
- `components/PageTransition.tsx` fades the old page out and the new one in when the page
  changes (160 ms each way, opacity only, instant under reduced motion); changes within a page
  show at once.
- Small UI motion, all `motion-safe`: a page's sections rise in staggered (`.page-stagger`, with
  `backwards` fill so nothing keeps a transform; it is a later rule than Tailwind's utilities,
  so a direct child of a page cannot animate itself), buttons lift and press, tabs slide their
  underline, Overview numbers count up (`lib/motion.ts`, `lib/useCountUp.ts`), clickable cards
  lift, loading states spin, and the API status dot pulses. A theme change the viewer picks goes
  through the View Transition API (`setPreference` in `lib/theme.tsx`): a snapshot of the whole
  page cross-fades, because gradients and the swapped day/night art cannot transition per
  property. Keyframes: `ui-rise`, `ui-fade` and `ui-pop` in `index.css`.
- Dropdowns use `components/Select.tsx` (themed, WAI-ARIA select-only combobox; key logic in
  `lib/listbox.ts`), never a native `<select>`, whose popup the OS paints in its own colors.
- `lib/data.tsx` loads the queue, lockfile, events and git status once and shares them
  with every page. It polls every 3 s while the API is connected. Refresh, or a decision,
  reloads all four.
- `lib/api.ts` validates every response with the shared zod schemas
  (`src/schema/event.ts` holds the event log schema for this reason).
- `lib/format.ts` holds the pure view logic (plain-language explanations, server
  summaries). Keep logic there, not in components, so `tests/web/` can test it in node.
- `lib/simulation.ts` holds the Simulation page's scenario (`RUG_PULL`, built from
  `tests/fixtures`) and turns the API's result into steps; `components/SimFlow.tsx` animates
  each step's messages between agent, proxy and server: a label above, and on the dotted line
  marching dashes and a stream of dots in the message's outcome color. Outcome labels are solid
  status colors with their AA-tested foregrounds so they read on light themes. The player
  starts at 0.5x; Space or K plays and pauses and the left/right arrows step when nothing
  interactive has focus (`playerKey`). Every verdict, tier, finding and error
  on that page comes from `POST /api/simulate`; without the API the page shows an error, never
  sample data.
- The nav (`components/AppShell.tsx`) is animated, all `motion-safe`: one highlight slides to
  the active link, links enter staggered, icons pop and nudge, the phone strip scrolls to the
  active link, and the Review Queue count pings while a tier-3 change waits. Arrow keys along
  the list (Up/Down in the sidebar, Left/Right in the strip), Home and End move focus and open
  the section once the keys pause (`NAV_OPEN_DELAY_MS`, `lib/nav.ts`), so tapping or holding
  a key does not restart the page fade on every press. The highlight is
  placed from the `<li>` offsets, not the link's: a transformed `<li>` becomes the link's
  offset parent.
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
- Card opacity (Settings > Card transparency) is a second preference, `latch.surface`, from
  0 to 1 (`lib/surface.ts`). `ThemeProvider` sets it as `--surface-mix` on `<html>`, and
  `bg-card-glass` raises the theme's `--surface-alpha` floor by that much toward solid, so
  it can only add opacity. `tests/web/themes.test.ts` checks text contrast at every step.

**Artwork.** `web/src/art/landscape.ts` generates an original pixel-art landscape from
seeded noise: a setting sun with dithered afterglow, clouds, a hazy distant range, a snowy
far range and forested mid range (each with sunlit and shadowed faces), a lake that mirrors
them with the sun's glitter path, a canoe, pine shores with a cabin, jetty, rocks and reeds,
and birds. Dark themes (`dark: true` in `themes.ts`, matching `color-scheme: dark`) get the
night scene: a cratered moon, stars and a moonlit path instead of the sun, no birds.
The art is drawn in named layers (`ART_LAYERS`), each a `<g class="art-<layer>">`. Moving parts
(clouds, birds, glints, smoke, stars, canoe, window) have their own layers, animated in
`index.css` only under `prefers-reduced-motion: no-preference`; second copies and alternate
poses are hidden by default, so the still scene is complete. Each theme names its own extra
in `themes.ts` (`art`): Default Light a balloon, Warm Retro a sailboat, Sunset sun rays and
geese (the rays thin out along their length, toward the top and the fan's edges), Terminal
Dark fireflies and a shooting star, Minimal snowfall, Forest Green a stag and
lake mist. `sceneFor(theme)` gives the time and extra; a test keeps the mapping one to one.
`AppShell` shows it as a fixed backdrop behind the content column on every page (the sidebar
stays plain): the art whole at the bottom, its sky stretched to the top as a gradient
(`--art-sky` to `--art-horizon`), with `starrySky()` stars at night. `PixelLandscape.tsx` draws
both as inline SVG with `crispEdges`, colored by the `--art-*` tokens of each theme; Minimal
uses muted greys. The art is decorative only: `aria-hidden`, `pointer-events-none`, and always
behind content. Cards over it use `bg-card-glass`: see-through by the theme's
`--surface-alpha`, which `tests/web/themes.test.ts` holds to 4.5:1 for text over any art color.
Text outside a card is not covered by that test; keep page headings near the top, where the
sky is plain. The favicon,
`web/public/favicon.svg`, is a 16x16 pixel-art padlock with a sunset; the page header shows it
next to the name, with a foreground glow so its dark outline reads on dark themes.

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
7. Commands: `verify` (the CI contract), then `inspect`, `init`, `review`, `add` (one
   server; shares `pinServer` and `proxiedEntry` with `init`).
8. `ui/` routes and wiring `web/` to `lib/api.ts`.
9. `analyze/llm.ts` last. It is optional and off by default.

## Commands

```sh
pnpm typecheck   # must stay at zero errors
pnpm test
pnpm build      # CLI into dist/, web UI into dist/web (latch review --ui)
pnpm ui         # API on 7777, Vite on 5173; set LATCH_LOCKFILE_PATH / LATCH_STATE_DIR
```

There is no browser test runner. To check the UI visually, serve the built bundle and use
`firefox --headless --screenshot`.

## Remaining work

- CI results are not stored, so the Git & CI page documents `latch verify` rather than
  showing CI runs, and no page shows live proxy connections.
- On Windows, MCP clients that spawn `latch` without a shell may not resolve `latch.cmd`.
