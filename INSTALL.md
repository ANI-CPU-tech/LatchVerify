# Installing LatchVerify

Every installer carries its own Node.js 22, so you do not need Node.js, pnpm or anything else.
Git is optional: with it, approvals are recorded under your `git config user.email`.

Download the file for your system from the [latest release](https://github.com/ANI-CPU-tech/LatchVerify/releases/latest).

## What installing does

LatchVerify **connects an MCP client only when you say so**: the Windows installer's
**Link your MCP clients now** checkbox, or `latch setup` afterwards, which lists the clients it
found and asks which to connect. Nothing asks where a `latch.lock` is.

1. Every stdio MCP server of a connected client is put behind the latch proxy. Only each entry's
   `command` and `args` change, in place: its `env`, where API keys live, comments and everything
   else in the file stay exactly as they were. No copy of the file is made.

   | Client | Config file (Windows / Linux) |
   |---|---|
   | Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` / `~/.config/Claude/claude_desktop_config.json` |
   | Claude Code | `~/.claude.json`: your servers, and each project's servers added with `claude mcp add` |
   | Cursor | `~/.cursor/mcp.json` |
   | VS Code, VS Code Insiders, VSCodium | `mcp.json` in the `User` folder of `Code`, `Code - Insiders` or `VSCodium` under `%APPDATA%` / `~/.config` |
   | Cline (VS Code extension) | `Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` under `%APPDATA%` / `~/.config` |
   | Cline CLI | `~/.cline/data/settings/cline_mcp_settings.json` |
   | Gemini CLI | `~/.gemini/settings.json` |
   | Zed | `%APPDATA%\Zed\settings.json` / `~/.config/zed/settings.json` |
   | LM Studio | `~/.lmstudio/mcp.json` |
   | Amazon Q Developer | `~/.aws/amazonq/mcp.json` and `~/.aws/amazonq/default.json` |

   A config that exists but cannot be read (for example half-written JSON) is reported and left
   untouched. Project files that teams commit (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`)
   are never rewritten: a wrapped entry holds paths of this machine.
2. Each server is recorded in **your own `latch.lock`**, created on the spot, and its tools are
   pinned the **first time your client starts it** (LatchVerify never starts a server with your
   keys itself). `latch.lock` keeps only the program's name and a hash of how it is started,
   never its arguments:

   | System | Your `latch.lock` |
   |---|---|
   | Windows | `%APPDATA%\LatchVerify\latch.lock` |
   | Linux | `~/.config/latchverify/latch.lock` (or `$XDG_CONFIG_HOME/latchverify/`) |
   | macOS | `~/Library/Application Support/LatchVerify/latch.lock` |

3. **Restart your MCP clients.** From then on, a tool that gains capabilities (for example a
   read-only tool that starts asking for shell commands) is blocked until you approve it.

Tools whose description already hides instructions are held for review instead of being pinned.
Open **LatchVerify** from your app menu (or its tray icon) to see them.

`latch review` and `latch verify` open your `latch.lock` from any directory. Inside a project
that has its own committed `latch.lock`, they use the project's file instead.

No MCP client installed yet? The installer still succeeds and says so. Install your client,
then run `latch setup` once, or connect it on the app's MCP Servers page.

**The LatchVerify app** sits in your tray and starts at login (Settings can turn that off). If it is
not running when an MCP client starts a protected server, that server's proxy starts it in the tray. It keeps
connected clients linked in the background (new servers included) and tells you on the desktop
when a tool waits for review, when a call was blocked, and when it finds a client you have not
answered about. On a machine without a desktop, `latch watch` does the same in a terminal.

Upgrading from an earlier version? It kept copies of your client configs as
`<config>.<date>.bak` next to them, keys included. `latch setup` lists them; delete them.

---

## Windows 10 / 11

1. Download `latchverify-<version>-windows-x64-setup.exe`.
2. Double-click it. It installs for your user only and does not need administrator rights.
3. Windows may show **"Windows protected your PC"** (SmartScreen) while the installer is
   unsigned. Click **More info → Run anyway**. (Maintainers: see `docs/CODE_SIGNING.md` to sign releases.)
4. Leave **Link your MCP clients now** checked, and finish. Then restart your MCP clients.

The installer also adds `latch` to your PATH for new terminals (an option you can untick), and a
Start menu entry, **LatchVerify Review**. If linking does not finish, the installer tells you,
and the details are in `%LOCALAPPDATA%\Programs\LatchVerify\setup.log`.

Silent install, for scripts: `latchverify-<version>-windows-x64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES`.
Add `/TASKS="addtopath"` to install without linking your MCP clients.

Uninstall from **Settings → Apps → Installed apps → LatchVerify**. Uninstalling gives every MCP
client its original server commands back and removes `latch` from your PATH.

---

## Debian / Ubuntu (and Linux Mint, Pop!_OS)

```bash
sudo apt install ./latchverify_<version>_amd64.deb
```

The package creates the `latch.lock` of the user who ran `sudo` and lists their MCP clients; it
connects none. Then, as yourself, run `latch setup` to choose which to connect, and restart those
clients. Uninstalling disconnects every client first.

To uninstall: `sudo apt remove latchverify`

---

## CachyOS (and other Arch-based distros: Arch, EndeavourOS, Manjaro, Garuda)

### Option A — install the ready-made package (recommended)

```bash
sudo pacman -U latchverify-bin-<version>-1-x86_64.pkg.tar.zst
```

To uninstall: `sudo pacman -R latchverify-bin`

### Option B — build the package yourself with makepkg

1. Put `packaging/arch/PKGBUILD`, `packaging/arch/latchverify.install`, `LICENSE` and
   `latchverify_<version>_amd64.deb` in the same, empty folder.
2. Set `pkgver` and `_debver` in `PKGBUILD` to that version.
3. In that folder run, as your normal user (not root):

   ```bash
   makepkg -si
   ```

---

## Any other Linux (portable archive, no root)

```bash
tar -xzf latchverify-<version>-linux-x64.tar.gz
./latchverify-<version>-linux-x64/install.sh
```

This installs to `~/.local/lib/latchverify`, puts `latch` in `~/.local/bin`, adds a menu entry,
and runs `latch setup`, which asks in your terminal which MCP clients to connect.
Set `PREFIX=/some/dir` to install somewhere else. Run `install.sh` from a newer archive to update.

To uninstall, run `./latchverify-<version>-linux-x64/uninstall.sh`. Use the same `PREFIX` if
you set one.

The bundled Node.js needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 and later).

---

## Linking and unlinking by hand

| Command | What it does |
|---|---|
| `latch setup` | List the MCP clients found and ask which to connect (without a terminal, only lists them). Creates your `latch.lock` if needed. |
| `latch setup --client cursor` | Connect one client without asking: `claude-desktop`, `claude-code`, `cursor`, `vscode`, `vscode-insiders`, `vscodium`, `cline`, `cline-cli`, `gemini-cli`, `zed`, `lm-studio` or `amazon-q`. |
| `latch setup --all` | Connect every client found without asking. |
| `latch setup --dry-run` | Show what would change, without writing anything. |
| `latch setup --remove --client cursor` | Disconnect a client: its servers get their original commands back. `--remove --all` for every client. Your `latch.lock` is kept, so connecting again keeps your approvals. |
| `latch watch` | Keep connected clients linked in the background and show desktop notifications. `--once` syncs one time and exits. |

Set `LATCH_SKIP_SETUP=1` while installing a Linux package or running `install.sh` to leave
your MCP clients alone (with `sudo`, use `sudo LATCH_SKIP_SETUP=1 apt install …`).

To use another lockfile, pass `--lockfile <path>` or set `LATCH_LOCKFILE_PATH`.

## Checking a download

Every release has a `SHA256SUMS` file:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

On Windows: `Get-FileHash latchverify-<version>-windows-x64-setup.exe`, then compare it with the line in `SHA256SUMS`.

---

## Updating

You never need to uninstall first, and your `latch.lock` and approvals are kept.

**The app updates itself.** It checks once a day, shows the release notes, and installs when you
click **Install now** (on Linux packages it asks for your password through `pkexec`). Each update is
checked against the release's ed25519 signature before it runs. `latch update` does the same from a
terminal; `latch update --check` only reports. To update by hand:

- **Windows:** run the newer installer.
- **Debian / Ubuntu:** `sudo apt install ./latchverify_<new-version>_amd64.deb`
- **CachyOS / Arch:** `sudo pacman -U latchverify-bin-<new-version>-1-x86_64.pkg.tar.zst`
- **Portable archive:** run `install.sh` from the new archive.

---

## Getting the installers built

The Windows installer has to be built on Windows (Inno Setup only runs there). The
**Build installers** GitHub Actions workflow builds every installer on GitHub's own Windows and
Linux machines. It then installs each one there, checks that Claude Code (set up for the test)
was linked and that its server still answers, uninstalls it, and checks that Claude Code was restored.

1. On GitHub, open the repository's **Actions** tab, choose **Build installers**, and click **Run workflow**.
2. When it finishes, open the run and download **latchverify-windows** (setup EXE),
   **latchverify-linux** (deb, Arch package, tar.gz) and **latchverify-checksums** from the
   Artifacts section.

To publish a release with all installers attached, set `version` in `package.json`, add a
`## <version>` section to `CHANGELOG.md`, commit, and push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

A version with a pre-release part, such as `0.2.0-rc.1`, is published as a pre-release.

To build the Linux packages on your own machine, see [packaging/README.md](packaging/README.md).
