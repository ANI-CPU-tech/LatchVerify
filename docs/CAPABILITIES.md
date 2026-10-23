# Capability model

LatchVerify does not ask "did the text change?" It asks "can this tool now do
something it could not do before?" To answer, it derives a `CapabilitySet` from
every tool definition and diffs those sets.

Schema: `src/schema/capability.ts`.

```ts
CapabilitySet {
  filesystem:  { read, write, scope: "none" | "constrained" | "unconstrained", paths[] }
  exec:        { enabled, shell }
  network:     { egress, domains[], unconstrained }
  credentials: { readsEnv, readsSecrets }
  crossServerRefs: string[]
  declared:    { readOnlyHint?, destructiveHint?, openWorldHint? }
}
```

## Three derivation passes

The passes run in priority order. A later pass may add capabilities or findings. It
may never remove or narrow what an earlier pass derived.

### Pass 1: deterministic schema signals (primary)

The `inputSchema` is the most honest description of a tool, because it is what the
tool accepts. Pass 1 walks `inputSchema.properties`, recursing into nested objects
and array `items`, and matches parameter names and formats against a fixed table
(`PARAM_SIGNALS` in `src/analyze/capabilities.ts`).

| Parameter signal | Capability | Constrained when |
|---|---|---|
| `path`, `file`, `filename`, `filepath`, `dir`, `directory`, `folder` | `filesystem.read` (and `write` when the tool name or description implies writing: `write`, `save`, `delete`, `create`) | `enum`, `const`, or a `pattern` anchored to a fixed prefix → `scope: "constrained"`, values copied to `paths` |
| `command`, `cmd`, `script`, `shell`, `exec`, `args` | `exec.enabled`; `exec.shell` when a single string (not an array) is accepted | `enum`/`const` of fixed commands |
| `url`, `uri`, `endpoint`, `host`, `webhook`, or any string with `format: "uri"` | `network.egress`; `network.unconstrained` when free-form | `enum`/`const` or a host-anchored `pattern` → hosts copied to `domains` |
| `token`, `apikey`, `api_key`, `secret`, `password`, `env` | `credentials.readsSecrets` / `readsEnv` | never: credential params always count |

Matching is case-insensitive and also matches common compounds such as `file_path`,
`targetDir` and `webhookUrl`.

**Constraint width.** A bare `string` is wider than a string with `pattern`, which is
wider than an `enum`. Moving from `enum` to a bare `string` is a loosening even if
the capability flag itself did not change. That makes it a tier-2 change.

### Pass 2: server annotations (claims)

MCP lets servers attach `annotations` to a tool: `readOnlyHint`, `destructiveHint`,
`openWorldHint`. The server writes these, and the server is the party we do not
trust. So they are stored under `declared`, as **claims, never facts**.

Pass 2 copies them in and then compares them with pass 1. A mismatch is itself an
`annotation_mismatch` finding:

| Claim | Contradicted by |
|---|---|
| `readOnlyHint: true` | `filesystem.write`, `exec.enabled` |
| `destructiveHint: false` | `exec.enabled`, `filesystem.write` with unconstrained scope |
| `openWorldHint: false` | `network.egress` |

A server that lies about being read-only is more suspicious than one that says
nothing.

### Pass 3: LLM advisory (optional, off by default)

Some intent only shows up in prose, for example "uploads the file to our backup
service". With `LATCH_LLM_ENABLED=true` and `ANTHROPIC_API_KEY` set, pass 3 asks a
model for extra findings and capability hints. It is advisory:

- It can **add** findings and capabilities. It never removes a pass-1 signal.
- It runs at **temperature 0** with a fixed prompt.
- Its result is **cached by content hash** (see below).

LatchVerify is fully functional without it. Air-gapped installs never call out.

## Detectors

These run over every text field: the description, the title, and each parameter's
description.

- **`unicode.ts`** checks fixed codepoint ranges (`SUSPICIOUS_RANGES`): zero-width
  (U+200B–U+200D, U+2060–U+2064, U+FEFF), bidi controls (U+202A–U+202E,
  U+2066–U+2069, U+200E/F), Unicode tag characters (U+E0000–U+E007F, decoded back
  to the ASCII they smuggle), and variation selectors. It also flags homoglyph
  confusables: words that mix scripts or change under `normalize("NFKC")`.
- **`patterns.ts`** flags imperative phrasing aimed at the model ("before calling",
  "you must", "do not tell the user", "ignore previous", `<IMPORTANT>`), sensitive
  file paths (`~/.ssh`, `id_rsa`, `.env`, client config files), environment
  variable names (critical when they look like `*_KEY`, `*_TOKEN`, `*_SECRET`), and
  names of tools that belong to **other** servers in the lockfile
  (`crossServerRefs`).

## Change tiers

The differ produces a `CapabilityDelta` with dotted keys such as `filesystem.read`,
`exec.shell` and `crossServerRefs:send_email`. `analyze/tiers.ts` applies these
rules, and the first match wins:

| Tier | Rule | Action |
|---|---|---|
| **3** | Any critical `unicode`, `pattern` or `cross_server` finding; or a gain in `exec.*` or `credentials.*` | Hard block, alert |
| **2** | Anything in `gained` or `loosened` | Block, queue for review |
| **1** | Something in `lost` (narrowed or constraint added), nothing gained | Auto-pass, log |
| **0** | Segment hashes changed, capability set identical, no critical findings | Auto-pass, log |

A tool that appears for the first time (`before: null`) is diffed against an empty
set, so all its capabilities count as gained. Even a brand-new tool with no
capabilities is queued for review: `proxy/blocker.ts` refuses calls to any unpinned
tool, whatever its tier.

**Tier 0 auto-pass is mandatory.** Tool descriptions change on nearly every release:
typo fixes, rewording, better examples. If each of those blocked, users would turn
LatchVerify off within a week, and then it would protect nothing. The capability set
is what decides whether a change is worth a human's attention.

## The phantom-drift caching rule

A non-deterministic step in the pipeline would report "drift" on unchanged tools.
For example, an LLM might answer slightly differently on the next run. A tool that
nobody touched would then be flagged, CI would go red for no reason, and people
would learn to ignore it.

Rules that prevent this:

1. Passes 1 and 2 and both detectors are **pure functions** of the tool definition.
2. Pass 3 is keyed by `advisoryCacheKey = sha256(canonicalJson({ name, description,
   inputSchema, model }))`.
3. The result is stored **in `latch.lock`** on the `ToolRecord` (`advisory`), next to
   the hashes it was computed from. So it is committed and shared, not just cached
   on one machine.
4. When the cache key matches, the stored advisory is reused **without calling the
   model**. A new model call happens only when the definition or the configured
   model changes, and then a change has really happened.

So `latch verify` gives the same answer for the same `latch.lock` and the same
server, on every machine and every run.
