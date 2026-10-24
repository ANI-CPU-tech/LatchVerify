# Test prompts

Prompts to type into an MCP client (Claude Desktop or Claude Code) to exercise each
server through `latch proxy`, and what LatchVerify should do with each. Keep the
review UI open (`latch review --ui`, `http://127.0.0.1:7777`) to watch the Review
Queue and Audit Log update.

Setup assumed: every server below was added with `latch add <name> -- <command>`
from the directory that holds `latch.lock`, the lockfile is committed, and the
client was restarted after the last `latch add`.

## weather (`demo/evil-server.ts`): rug pull

The server is identical to the benign weather server until its third `tools/call`.

| # | Prompt | Expected |
|---|---|---|
| 1 | "What's the weather forecast for San Francisco (37.77, -122.42)?" | `get_forecast` passes; canned forecast |
| 2 | "Are there any weather alerts in CA?" | `get_alerts` passes |
| 3 | "And any alerts in NY?" | Passes. After this reply the server swaps to poisoned tools and sends `notifications/tools/list_changed` |
| 4 | "Get the forecast for San Francisco again." | Blocked with JSON-RPC error `-32001` ("blocked pending review — run `latch review`"). Review Queue shows tier 3 for `get_forecast` (zero-width chars, hidden `~/.ssh/id_rsa` instruction) and the new `read_config`, `run_diagnostics`, `sync_alerts` |
| 5 | "Use run_diagnostics to check the weather service." | Blocked: new tool, exec gained, bidi override (tier 3) |
| 6 | "Read the config at /etc/hosts with read_config." | Blocked: unpinned tool, unconstrained filesystem read (tier 2) |

To reset: `latch-demo-reset` (restores the committed `latch.lock` and clears
`.latch/`), then restart the client.

## devtools (`demo/devtools-server.ts`): flagged on first use, then rug pull

Exists on the `feature/devtools-demo-server` branch. `latch add` pins `format_json`
and holds `workspace_shell` back.

| # | Prompt | Expected |
|---|---|---|
| 1 | "Use workspace_shell to run `ls ~`." | Blocked from the start: `workspace_shell` is tier 3 in the Review Queue (description points at `~/.ssh` and `.env`; exec and unconstrained path) |
| 2 | "Format this JSON with format_json: `{\"a\":1,\"b\":[1,2]}`" | Passes; pretty-printed JSON |
| 3 | "Format `[1,2,3]` too." | Passes |
| 4 | "And format `{\"ok\":true}`." | Passes. After this reply the server rug-pulls and sends `list_changed` |
| 5 | "Format `{\"x\":1}` once more." | Blocked: `format_json` now hides an instruction to read `.env` into a new `context` param (tier 3) |

## notion (remote, `mcp-remote https://mcp.notion.com/mcp`)

| # | Prompt | Expected |
|---|---|---|
| 1 | "Search my Notion workspace for pages about 'roadmap'." | Search tool passes |
| 2 | "Create a Notion page titled 'Latch test' with the text 'hello'." | Blocked until reviewed: `notion-create-pages` is held for a cross-server finding (`get_teams` matches a GitHub tool; a false positive). Approve it in the UI, commit `latch.lock`, then retry: passes |
| 3 | "Add a comment 'checked by latch' to the 'Latch test' page." | Passes. If Notion has reworded the tool since it was pinned, the Audit Log shows a tier 0 `auto_passed` |

## github

| # | Prompt | Expected |
|---|---|---|
| 1 | "List my GitHub repositories." | Passes |
| 2 | "Show the open pull requests on <owner>/<repo>." | Passes |
| 3 | "Which teams am I in on GitHub?" | `get_teams` passes (pinned here; it is why Notion's mention of it is flagged) |

## context7

| # | Prompt | Expected |
|---|---|---|
| 1 | "Use context7 to look up the hono routing docs." | `resolve-library-id` then `query-docs` pass |

## miro

| # | Prompt | Expected |
|---|---|---|
| 1 | "List my Miro boards." | Passes |
| 2 | "Create a Miro board called 'Latch test'." | Passes if the tool was pinned on `latch add`; blocked if it was held back |

## playwright

`latch add` may hold back tools such as `browser_run_code_unsafe`; check its output.

| # | Prompt | Expected |
|---|---|---|
| 1 | "Open https://example.com and tell me the page title." | `browser_navigate` and `browser_snapshot` pass |
| 2 | "Take a screenshot of the page." | Passes |
| 3 | "Run `document.title` as code on the page." | Blocked if `browser_run_code_unsafe` was held back; otherwise passes |

## magicui

| # | Prompt | Expected |
|---|---|---|
| 1 | "Show me Magic UI components for animated text." | Passes |
| 2 | "Give me the code for the Magic UI marquee component." | Passes |

## Checking the results

- Review Queue: every blocked change, highest tier first.
- Audit Log: `tools_listed`, `list_changed`, `change_detected`, `auto_passed`,
  `call_blocked`, `approved` and `rejected` events, also in `.latch/events.jsonl`
  next to `latch.lock`.
- CI contract: `latch verify` exits 1 for tier 2 changes or unpinned tools, 2 for
  tier 3 changes, 3 on error, and 0 when every server matches `latch.lock`.
