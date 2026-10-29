# Architecture

LatchVerify is a **transparent stdio proxy**. The MCP client thinks it is talking to
the real server. The real server thinks it is talking to the client. LatchVerify reads
every message in between and steps in at three points.

## Process model

```
┌────────────┐  stdin/stdout   ┌──────────────────┐  stdin/stdout   ┌──────────────┐
│ MCP client │ ◄─────────────► │   latch proxy    │ ◄─────────────► │  real server │
│ (Claude,   │  JSON-RPC lines │  (this package)  │  JSON-RPC lines │ (child proc) │
│  Cursor…)  │                 └────────┬─────────┘                 └──────────────┘
└────────────┘                          │ reads / writes
                              ┌─────────┴──────────┐
                              │ latch.lock  (git)  │
                              │ .latch/pending.json│
                              │ .latch/events.jsonl│
                              └────────────────────┘
```

`latch init` (or `latch add`, for one server) rewrites each server entry in the client
config. This:

```json
{ "command": "node", "args": ["weather.js"] }
```

becomes this:

```json
{ "command": "/usr/bin/node", "args": ["/path/to/latchverify/dist/cli.js", "proxy", "--server", "weather", "--", "node", "weather.js"] }
```

The entry names node and `dist/cli.js` by absolute path: clients start servers without
the user's shell setup, so a `latch` on the user's PATH (or a shell function) may not be
visible to them. An entry of the form `latch proxy ...` is still recognized as wrapped.

The client launches `latch proxy`. The proxy launches the original command as a
child process with `child_process.spawn` and piped stdio. The child's stderr passes
straight through. The proxy's own logs go to stderr and `.latch/events.jsonl`,
never stdout, because stdout is the protocol.

## The three interception points

| Message | Direction | What LatchVerify does |
|---|---|---|
| `tools/list` response | server → client | Capture every tool, extract capabilities, diff against `latch.lock`, queue changes. The list is still forwarded, except that a tier-3 tool reaches the client as its name and a "withheld" notice, never its own description or schema. |
| `tools/call` request | client → server | Block when the tool is unpinned or has a pending tier-2+ change. Otherwise forward. |
| `notifications/tools/list_changed` | server → client | The rug-pull signal. Re-fetch `tools/list` from the server and analyze it before the client acts on the change. Then forward the notification. |

Everything else (`initialize`, `resources/*`, `prompts/*`, pings, unknown methods) is
forwarded byte-for-byte. The proxy only records the negotiated protocol version from
the `initialize` response, which it stores in `ToolRecord.specVersion`.

To tell a `tools/list` response apart from other responses, the proxy keeps an
`inflight` map from client request id to method (`InterceptorContext.inflight`).

### Why enforce at `tools/call` and not `tools/list`

Removing a tool from `tools/list` makes the model believe the tool never existed,
so it may improvise, retry, or give confusing answers. Leaving the tool listed and
failing the call with a clear error makes the model tell the user what happened.

### Blocking

A blocked call never reaches the server. The proxy answers the client directly:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32001,
    "message": "LatchVerify blocked \"get_forecast\" pending review — run `latch review`",
    "data": { "reason": { "kind": "hard_block", "changeId": "chg_7f3a91" } }
  }
}
```

The error message is written for the model to read and relay. An error response,
rather than a dropped request, keeps the agent from hanging until a timeout.

## Pipeline

Each tool in a `tools/list` response goes through the same five stages:

```
capture ──► extract ──► diff ──► tier ──► enforce
```

1. **Capture** (`proxy/interceptor.ts`). Validate the result with
   `McpToolListSchema`. The schema is loose so unknown fields survive.
2. **Extract** (`analyze/hash.ts`, `analyze/capabilities.ts`, `analyze/unicode.ts`,
   `analyze/patterns.ts`, `analyze/llm.ts`). Hash each segment (name, description,
   inputSchema) and derive the `CapabilitySet` in three passes: schema signals,
   annotation claims, optional cached LLM advisory. Run the Unicode and pattern
   detectors over every text field. See [CAPABILITIES.md](CAPABILITIES.md).
3. **Diff** (`analyze/differ.ts`). Compare segment hashes to see what changed, and
   compare capability sets to get a `CapabilityDelta` (`gained`, `lost`, `loosened`).
4. **Tier** (`analyze/tiers.ts`). Classify the change as tier 0 to 3 from the delta
   and the findings.
5. **Enforce** (`store/pending.ts`, `proxy/blocker.ts`). Tier 0 and 1 are logged and
   auto-pass. Tier 2 and 3 become a `PendingChange` in `.latch/pending.json`, and
   `tools/call` for that tool is blocked until the change is approved in `latch.lock`.

Every decision is appended to `.latch/events.jsonl` (`store/events.ts`).

## Approval flow

```
proxy detects tier-2 change ─► .latch/pending.json ─► latch review (terminal or --ui)
      ─► approve ─► latch.lock rewritten ─► git commit + PR ─► teammate reviews diff
      ─► merge ─► every machine's proxy now allows the new definition
```

Rejecting a change instead records its definition (server, tool and composite hash) in
`.latch/rejected.json`. The proxy blocks calls to the tool, whatever the tier, for as long as
the server serves that exact definition, and does not queue it again, even after a restart.
Delete the entry from `rejected.json` to take a rejection back.

`latch verify` runs the same capture → tier pipeline in CI against every server in
`latch.lock` and exits non-zero on tier-2+ drift. See [LOCKFILE.md](LOCKFILE.md).

## Why raw JSON-RPC instead of the MCP SDK

The official SDKs are built for writing clients and servers. They parse messages
into typed objects and re-serialize them. For a proxy that causes three problems:

1. **Unknown fields are lost.** SDK schemas strip or reject fields they do not model:
   vendor extensions, fields from a newer protocol revision, `_meta` keys. The
   client then receives something different from what the server sent, and the
   breakage is silent.
2. **Version coupling.** The proxy would only understand the protocol revision its
   SDK version understands. A raw proxy forwards new methods it has never seen.
3. **The proxy would become an endpoint.** An SDK client/server pair answers
   `initialize`, pings and capability negotiation itself. A transparent proxy must
   let the real endpoints negotiate with each other.

So `proxy/transport.ts` reads stdin and the child's stdout with `readline`, one
JSON-RPC message per line, and keeps the original line (`Frame.raw`). Untouched
frames are written back byte-for-byte. Only messages the proxy rewrites or creates
(block errors, its own `tools/list` re-fetch) are serialized.

## Module map

| Path | Responsibility |
|---|---|
| `src/schema/` | zod schemas and inferred types. The shared contract. |
| `src/proxy/transport.ts` | JSON-RPC types, line framing, spawning the child |
| `src/proxy/interceptor.ts` | Routing frames to the three interception handlers |
| `src/proxy/blocker.ts` | Block verdict and the JSON-RPC error |
| `src/proxy/index.ts` | `startProxy` lifecycle and signal forwarding |
| `src/analyze/*` | Hashing, capability extraction, detectors, diff, tiers, LLM pass |
| `src/store/*` | `latch.lock`, pending queue, event log |
| `src/commands/*` | One file per CLI command |
| `src/config/*` | Env loading and MCP client config detection and rewriting |
| `src/ui/*` | hono review API, bound to 127.0.0.1 |
| `web/` | React review UI |
