# Changelog

## Unreleased

### Installers
- **Windows installer, Debian/Ubuntu and Arch/CachyOS packages, and a portable Linux archive**, built by the **Build installers** workflow on GitHub's Windows and Linux machines. Each carries its own Node.js 22, so nothing else needs installing.
- **The LatchVerify app comes with every installer**: it starts after installing (Windows), from your app menu or in the tray (Linux), and at login. Uninstalling stops it and removes its login start.
- **Installing creates your per-user `latch.lock` and connects only the MCP clients you choose**: the Windows installer's checkbox, or `latch setup` afterwards on Linux (`install.sh` asks in your terminal). Uninstalling gives every client its original server commands back (`latch setup --remove --all`) and keeps `latch.lock`; before, only Claude Code was restored, and a client linked by hand kept pointing at the removed install.

### Added
- **`latch setup`** lists the MCP clients found and asks which to connect (`--client` or `--all` connect without asking), using the per-user lockfile: `%APPDATA%\LatchVerify` on Windows, `~/.config/latchverify` on Linux, `~/Library/Application Support/LatchVerify` on macOS. It is safe to run again, and it succeeds with a note when no client is set up yet.
- **`latch setup --remove`** restores the client's original server entries, keeping their own settings.
- **`latch setup --all` and `latch setup --remove --all`** link or unlink every MCP client on the machine at once.
- **Eight more MCP clients**: VS Code Insiders, VSCodium, Cline (VS Code extension), Cline CLI, Gemini CLI, Zed, LM Studio and Amazon Q Developer, on top of Claude Desktop, Claude Code, Cursor and VS Code. Each config location was checked against the client's own docs or source. Roo Code (shut down) and Windsurf/Devin Desktop (its docs give two different paths) are left out.
- **Claude Code's per-project servers** (`claude mcp add` in a project, kept in `~/.claude.json`) are protected too. Project `.mcp.json` files are not rewritten: teams commit them, and a wrapped entry holds this machine's paths.
- **`latch review` and `latch verify` open the per-user lockfile** when run outside a project, instead of asking for `./latch.lock`. A project's own `latch.lock` still wins inside the project.
- **`latch lock status`, `latch lock accept` and `latch lock restore`** check `latch.lock` for edits made outside LatchVerify, show what changed tool by tool, and trust or undo them.
- **Reviewers see the description a tool now serves**, in `latch review` and in the review UI, not only that it changed.
- **`LATCH_LOG_LEVEL` works**: `debug` names every frame the proxy holds, rewrites or answers itself; `warn` keeps stderr quiet. Warnings and errors are tagged.
- **`latch watch`** keeps connected clients linked in the background: new servers are linked within a second, entries a client turned back are re-wrapped, entries of a moved install are repaired.
- **Desktop notifications** (notify-send on Linux, a toast on Windows) when changes wait for review at start, when a proxy queues a change, when calls are blocked (repeats summed per minute) and when a new MCP client is found. Settings has switches for them, for update checks and for starting at login.
- **The MCP Servers page shows each client and its servers**: which client starts which server, whether it is protected, waiting for its first run or not connected, with Connect and Disconnect.
- **The LatchVerify app** (Electron): the review UI in its own window and a tray icon with the review queue count, Pause watching, Check for updates and Quit. It runs the background sync and shows native notifications; clicking one opens the review queue. Closing the window keeps it in the tray, and it starts at login unless Settings turns that off. The window loads only its own loopback server: no new windows, no navigation elsewhere, sandboxed with context isolation.
- **Opening an MCP client brings the app up.** When a client starts a protected server and the installed app is not running, the proxy starts it hidden in the tray, passing it only the desktop session's variables, never the server's keys. A second start never pops the window up.
- **Updates, signed.** The app checks for a new release 10 s after it starts and then once a day (Settings can turn this off), shows the release notes and installs on one click: the Windows installer, `apt-get` or `pacman` through `pkexec`, or the portable archive's own `install.sh`. Nothing is downloaded before you click. Every release publishes a `latest.json` signed with ed25519; the installer's sha256 and signature are checked before it runs. `latch update` does the same from a terminal, and `latch update --check` only reports. A source checkout never updates itself.
- **Dev Tools** (development mode only) and `pnpm demo:add` add the demo servers to a client in one step.

### Changed
- **Nothing is connected without your say-so.** LatchVerify connects an MCP client only after you answer yes: `latch setup` lists the clients it found and asks, `--client` and `--all` connect without asking, the Windows installer has a checkbox, and the MCP Servers page has Connect and Disconnect. Linux packages connect nothing by themselves. Your answers are kept in `settings.json`.
- **Tools are pinned on a server's first run**, by the proxy your client starts, instead of by LatchVerify starting each server with your keys when linking. A tool with hidden instructions is still held for review.
- **`latch.lock` no longer stores launch lines.** Each server keeps its program name and a hash of how it is started; arguments, which can hold a key, never reach git. Older lockfiles are read and converted. `latch verify` takes launch lines from `--config <file>` (for example `.mcp.json`), `./.mcp.json` or the client configs, and its `--json` report (version 2) names the program only.
- **Linked entries keep your env untouched**: only `command` and `args` change, the lockfile path travels as `--lockfile`, and no `.bak` copy of the config is made any more. `latch setup` lists the copies earlier versions left, which hold your keys, so you can delete them.
- **The demo stays out of real installs.** The Simulation page and its API (`POST /api/simulate`) exist only in development mode, `LATCH_DEV=1`. Its code and the demo tool lists load as a separate chunk only then. An installed review UI never shows sample data: when the API is down, it says so.
- **LatchVerify opens no browser.** `latch review --ui` serves the review UI and prints its address; the app is how you open it. The `latchverify-review` launcher and the **LatchVerify Review** menu entry are replaced by **LatchVerify**.
- **CI runs on every push**, on Linux and Windows (`ci.yml`), and Windows test failures now fail the installer build instead of being reported only.
- **`GET /api/info`** reports the running version and whether development mode is on.

### Security
- **Your keys never leave your client configs.** Env values are dropped as soon as a config is parsed and never reach LatchVerify's files, logs, API or dashboard; a canary test runs every command, the proxy and the API over configs holding a fake key and fails if it appears anywhere.
- **Guarded servers no longer get LatchVerify's own variables.** The LLM API key and the paths of `latch.lock` and the review queue used to reach every wrapped server. No `LATCH_*` variable reaches a server now, and `.env` files only load `LATCH_*` lines.
- **A server cannot approve its own change by editing `latch.lock`.** Every lockfile LatchVerify writes is recorded in an HMAC-signed integrity record under a per-user key. A proxy refuses a `latch.lock` the record does not vouch for, keeps the version it trusts and logs a `lock_tampered` event. After a `git pull`, run `latch lock accept`. This detects tampering; a program written against LatchVerify, running as the same user, can still defeat it.
- **Tier-3 tool descriptions no longer reach the model.** A tool with a hidden instruction is passed on as its name and a "withheld pending review" notice, not its own text.
- **Rejections last.** A rejected definition stays blocked after the proxy restarts, whatever its tier, and is not queued for review again.

### Fixed
- **A pin or approval made while `latch init` or `latch add` was running is no longer lost**: their write is merged into `latch.lock` as it is then, under the shared state lock.
- **Each `latch proxy` uses about 70 MiB instead of 89**, and `latch watch` about 75 instead of 88: commands load only what they use, and wrapped entries start node with a smaller young generation.
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
