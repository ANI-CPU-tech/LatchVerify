# Changelog

## Unreleased

### Installers
- **Windows installer, Debian/Ubuntu and Arch/CachyOS packages, and a portable Linux archive**, built by the **Build installers** workflow on GitHub's Windows and Linux machines. Each carries its own Node.js 22, so nothing else needs installing.
- **Installing links every MCP client found** (`latch setup --all`). Right after installing, their MCP servers are put behind the latch proxy and their tools are pinned in a per-user `latch.lock`, created on the spot. Nothing asks where a lockfile is. Uninstalling gives every client its original server commands back (`latch setup --remove --all`) and keeps `latch.lock`; before, only Claude Code was restored, and a client linked by hand kept pointing at the removed install.

### Added
- **`latch setup`** links Claude Code (or another client with `--client`) with no questions, using the per-user lockfile: `%APPDATA%\LatchVerify` on Windows, `~/.config/latchverify` on Linux, `~/Library/Application Support/LatchVerify` on macOS. It is safe to run again, and it succeeds with a note when Claude Code is not installed yet.
- **`latch setup --remove`** restores the client's original server entries, keeping their own settings.
- **`latch setup --all` and `latch setup --remove --all`** link or unlink every MCP client on the machine at once.
- **Eight more MCP clients**: VS Code Insiders, VSCodium, Cline (VS Code extension), Cline CLI, Gemini CLI, Zed, LM Studio and Amazon Q Developer, on top of Claude Desktop, Claude Code, Cursor and VS Code. Each config location was checked against the client's own docs or source. Roo Code (shut down) and Windsurf/Devin Desktop (its docs give two different paths) are left out.
- **Claude Code's per-project servers** (`claude mcp add` in a project, kept in `~/.claude.json`) are protected too. Project `.mcp.json` files are not rewritten: teams commit them, and a wrapped entry holds this machine's paths.
- **`latch review` and `latch verify` open the per-user lockfile** when run outside a project, instead of asking for `./latch.lock`. A project's own `latch.lock` still wins inside the project.
- **`latch lock status`, `latch lock accept` and `latch lock restore`** check `latch.lock` for edits made outside LatchVerify, show what changed tool by tool, and trust or undo them.
- **Reviewers see the description a tool now serves**, in `latch review` and in the review UI, not only that it changed.
- **`LATCH_LOG_LEVEL` works**: `debug` names every frame the proxy holds, rewrites or answers itself; `warn` keeps stderr quiet. Warnings and errors are tagged.

### Changed
- **The demo stays out of real installs.** The Simulation page and its API (`POST /api/simulate`) exist only in development mode, `LATCH_DEV=1`. Its code and the demo tool lists load as a separate chunk only then. An installed review UI never shows sample data: when the API is down, it says so.
- **`GET /api/info`** reports the running version and whether development mode is on.

### Security
- **Guarded servers no longer get LatchVerify's own variables.** The LLM API key and the paths of `latch.lock` and the review queue used to reach every wrapped server. No `LATCH_*` variable reaches a server now, and `.env` files only load `LATCH_*` lines.
- **A server cannot approve its own change by editing `latch.lock`.** Every lockfile LatchVerify writes is recorded in an HMAC-signed integrity record under a per-user key. A proxy refuses a `latch.lock` the record does not vouch for, keeps the version it trusts and logs a `lock_tampered` event. After a `git pull`, run `latch lock accept`. This detects tampering; a program written against LatchVerify, running as the same user, can still defeat it.
- **Tier-3 tool descriptions no longer reach the model.** A tool with a hidden instruction is passed on as its name and a "withheld pending review" notice, not its own text.
- **Rejections last.** A rejected definition stays blocked after the proxy restarts, whatever its tier, and is not queued for review again.

### Fixed
- **Configs with comments or trailing commas** (common in VS Code's `mcp.json` and Zed's `settings.json`) are read and linked instead of skipped, and rewriting one keeps every comment: only the changed entries are edited.
- **A client config that cannot be read is reported** (`! cursor: ~/.cursor/mcp.json is not valid JSON: ... at line 3, column 5`) instead of being skipped in silence, and it is never rewritten.
- **Config backups no longer pile up**: only the 5 newest `.bak` copies of each config are kept.
- **`npx`, `pnpm` and other `.cmd` servers start on Windows**, so `latch init` and `latch setup` protect them instead of skipping them.
- **Servers that print a banner on stdout can be pinned.** Lines that are not JSON-RPC are skipped, and the first is reported.
- **A call to a server that was never pinned tells the model to run `latch init`**, not `latch review`, which could not help.
- **The proxy never waits forever on a server**: SIGTERM after 5 s without input, SIGKILL 5 s after any signal, and the server is killed if the proxy exits first.
- **Servers that ask the client something before listing their tools no longer stall**: while a call waits for verification, only later calls are held, not the client's answers.
- **A single line over 64 MiB stops the server** instead of growing memory without bound.
- **The queue lock is never taken over from a live holder**, so a slow approval cannot lose its lock, and two waiters cannot both remove one stale lock.
- **The event log rotates at 5 MB** to `events.1.jsonl` instead of growing forever.
- **The capture introduces itself with the real version** instead of 0.0.0.
