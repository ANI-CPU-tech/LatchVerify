# `latch.lock`

`latch.lock` is the approved state of every MCP tool your agents may call. It is a
JSON file at the repo root, **committed to git**. LatchVerify trusts nothing else:
the proxy and `latch verify` both compare live tool definitions against it.

Schema: `src/schema/lockfile.ts` and `src/schema/tool.ts`. Full example:
[`latch.lock.example`](../latch.lock.example).

## Format

```jsonc
{
  "version": "1",                          // lockfile format version
  "generatedAt": "2026-10-20T14:02:11.000Z",
  "servers": {
    "weather": {                           // serverId: the key used in `latch proxy --server`
      "transport": "stdio",                // "stdio" | "http"
      "command": "npx",                    // how the real server is launched
      "args": ["tsx", "demo/weather-server.ts"],
      "tools": [
        {
          "name": "get_forecast",
          "serverId": "weather",           // must equal the enclosing key
          "hashes": {
            "name":        "<sha256 hex>",
            "description": "<sha256 hex>",
            "inputSchema": "<sha256 hex>",
            "composite":   "<sha256 hex>"
          },
          "capabilities": { /* CapabilitySet, see CAPABILITIES.md */ },
          "approvedBy": "alice@example.com",
          "approvedAt": "2026-10-20T14:02:11.000Z",
          "specVersion": "2025-06-18",     // MCP revision negotiated at capture time
          "advisory": { /* optional cached LLM pass: contentHash, model, findings */ }
        }
      ]
    }
  }
}
```

The schema rejects:

- a hash that is not 64 lowercase hex characters;
- a non-ISO-8601 timestamp;
- a tool whose `serverId` differs from the server key it is filed under;
- two tools with the same name in one server.

Approved records store **hashes and capabilities, not the raw definitions**. The
lockfile stays small, and its diff is about what matters. When a change is queued
the proxy has the live definition in hand, and the review API attaches its text to
the pending change so the UI can show a description diff (`ReviewItem` in
`web/src/lib/api.ts`).

### Stable output

`store/lockfile.ts` writes servers sorted by key and tools sorted by name, with
2-space indentation and a trailing newline. So the same approved state always
produces the same bytes, and a PR diff shows only the tools that really changed.

## Segment hashing

Each tool is hashed in three segments plus a composite:

| Segment | Input |
|---|---|
| `name` | `sha256(name)` |
| `description` | `sha256(description ?? "")` |
| `inputSchema` | `sha256(canonicalJson(inputSchema))`: keys sorted recursively, no whitespace |
| `composite` | `sha256(name + ":" + description + ":" + inputSchema)`, joining the three hex digests |

Why segments instead of a single hash:

- **Attribution.** The differ can say *"description changed, schema unchanged"*. That
  is often the first hint of a tier-0 reword, or of a prompt injection that left the
  schema alone.
- **Cheap equality.** `composite` decides "unchanged" in one comparison, which is
  the common case on every `tools/list`.
- **No text in the lockfile.** Hashes reveal nothing about a private server's
  descriptions.
- **Canonical JSON** means reordering keys in `inputSchema` is not a change.
  Description text is hashed **as is**, with no Unicode normalization, so a single
  inserted zero-width character still changes the hash and gets analyzed.

## Approval workflow

Approving a tool change is a pull request.

```
1. Proxy (or latch verify) detects a tier-2+ change
   └─► .latch/pending.json  (local, gitignored)

2. Developer runs `latch review` (or `latch review --ui`)
   └─► sees the capability diff, findings and description diff
   └─► approve ─► latch.lock is rewritten with the new ToolRecord,
                  approvedBy = git user.email, approvedAt = now

3. git checkout -b approve-weather-get-forecast
   git commit latch.lock -m "approve weather/get_forecast: adds units param"
   └─► open a PR

4. A teammate reviews the latch.lock diff
   └─► the changed capabilities block is right there in the diff

5. Merge
   └─► every teammate's proxy and CI now accept the new definition
```

Because the lockfile lives in git, you get everything git gives you: review, blame,
revert, branch protection and CODEOWNERS (for example, require the security team on
`latch.lock`). Nobody has to run or trust a separate approval service.

Tier 0 and tier 1 changes do not block. The proxy logs them, and `latch review`
offers to fold them into the lockfile so hashes stay current. Skipping that is safe,
because they keep auto-passing.

## `latch verify`: the CI contract

```sh
latch verify            # human-readable
latch verify --json     # machine-readable report
```

`latch verify` launches every server listed in `latch.lock`, requests `tools/list`,
runs the full pipeline, and compares the result with the pinned records. It writes
nothing.

| Exit code | Meaning |
|---|---|
| `0` | Every live tool matches its pin, or differs only at tier 0/1 |
| `1` | **Drift**: at least one tier-2 change, or a tool that is not pinned |
| `2` | **Hard block**: at least one tier-3 change |
| `3` | Error: a server failed to start or returned invalid JSON-RPC |

Any non-zero exit fails the job. Example GitHub Actions step:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm exec latch verify
```

Run it on every PR, and also on a schedule. A rug pull happens on the server's
side with no commit in your repo, so a nightly `latch verify` is what catches it
when no proxy is running.

## Which `latch.lock` a command uses

1. `--lockfile <path>`, then `LATCH_LOCKFILE_PATH`. Entries wrapped by `latch init`,
   `latch add` and `latch setup` set `LATCH_LOCKFILE_PATH`, so the proxy always opens the
   file it was linked to, wherever the client starts it.
2. `./latch.lock`, the project's committed file.
3. Only for `latch review` and `latch verify`, when there is no `./latch.lock`: the
   **per-user lockfile**, if it exists. `latch setup` and the installers create it at
   `%APPDATA%\LatchVerify\latch.lock` (Windows), `~/.config/latchverify/latch.lock`
   (Linux, or `$XDG_CONFIG_HOME/latchverify/`) or
   `~/Library/Application Support/LatchVerify/latch.lock` (macOS).

`latch setup` itself skips step 2: without a flag or `LATCH_LOCKFILE_PATH`, it always links
to the per-user lockfile, so running it inside a project does not touch that project's file.

The state directory (`.latch/`) defaults to the lockfile's own directory, so a per-user
lockfile keeps its review queue and event log next to it. `LATCH_STATE_DIR` or `--state-dir`
overrides that.

The per-user lockfile is not in a git repository, so approvals there are not pull requests.
Teams that want reviewed approvals keep a committed `latch.lock` in the project and run
`latch init` there instead.

## Local state that is *not* committed

| Path | Contents |
|---|---|
| `.latch/pending.json` | Review queue (`PendingChange[]`) with before/after records and findings |
| `.latch/events.jsonl` | Append-only log of every proxy and CLI decision |

Both are listed in `.gitignore`. `latch.lock` is deliberately **not** listed.
