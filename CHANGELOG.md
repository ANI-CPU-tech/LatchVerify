# Changelog

## Unreleased

### Installers
- **Windows installer, Debian/Ubuntu and Arch/CachyOS packages, and a portable Linux archive**, built by the **Build installers** workflow on GitHub's Windows and Linux machines. Each carries its own Node.js 22, so nothing else needs installing.
- **Installing links Claude Code.** Right after installing, Claude Code's MCP servers are put behind the latch proxy and their tools are pinned in a per-user `latch.lock`, created on the spot. Nothing asks where a lockfile is. Uninstalling gives Claude Code its original server commands back and keeps `latch.lock`.

### Added
- **`latch setup`** links Claude Code (or another client with `--client`) with no questions, using the per-user lockfile: `%APPDATA%\LatchVerify` on Windows, `~/.config/latchverify` on Linux, `~/Library/Application Support/LatchVerify` on macOS. It is safe to run again, and it succeeds with a note when Claude Code is not installed yet.
- **`latch setup --remove`** restores the client's original server entries, keeping their own settings.
- **`latch review` and `latch verify` open the per-user lockfile** when run outside a project, instead of asking for `./latch.lock`. A project's own `latch.lock` still wins inside the project.
