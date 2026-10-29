# Packaging

How the LatchVerify installers are built. `.github/workflows/build-installers.yml` runs all of
this on GitHub's Windows and Linux machines. Users read [INSTALL.md](../INSTALL.md) instead.

## What every package holds

```
app/           package.json, LICENSE, README.md, dist/ (CLI and review UI), node_modules/ (production, flat)
node/          Node.js 22, downloaded from nodejs.org and checked against its SHA256SUMS
latch          launcher: the bundled node running app/dist/cli.js (latch.cmd on Windows)
```

Installing runs `latch setup --all`, and uninstalling runs `latch setup --remove --all` (see
`src/commands/setup.ts`). Because latch runs from the bundled node, the client entries
it writes point at the install directory's `node` and `app/dist/cli.js` by absolute path. They
keep working whatever is on PATH.

## Files

| File | Role |
|---|---|
| `stage.ts` | Copies the built app into `<out>/app` and installs production dependencies from `pnpm-lock.yaml` (frozen, no scripts, hoisted, so no symlinks). |
| `version.ts` | `package.json`'s version in each format: `semver`, `deb` (`1.2.0~rc.1`), `arch` (`1.2.0rc1`), `windows` (`1.2.0.0`). |
| `release-notes.ts` | The GitHub release body: the version's `CHANGELOG.md` section plus a downloads table. |
| `linux/fetch-node.sh`, `windows/fetch-node.ps1` | Download a verified Node.js 22 into `<stage>/node`. `NODE_VERSION=v22.x.y` pins a release. |
| `linux/build-deb.sh` | The `.deb`: `/usr/lib/latchverify`, `/usr/bin` links, desktop entry and icon. Uses `debian/control.in`, `postinst` and `prerm`. |
| `linux/link-user` | What the package scripts call. Runs `latch setup --all` (or `--remove --all`) as the user behind `sudo`/`pkexec`, never as root. Never fails the package. |
| `arch/PKGBUILD`, `arch/latchverify.install` | Repackage the `.deb` for pacman, with the same link and unlink hooks. |
| `linux/build-tarball.sh`, `install.sh`, `uninstall.sh` | The portable archive and its per-user installer (no root, `~/.local`). |
| `windows/latchverify.iss` | Inno Setup script for the per-user setup EXE: `latch.cmd`, the icon, Start menu entry and an optional PATH entry. |
| `test/check-link.ts`, `test/stub-server.mjs` | Smoke-test helpers: write a Claude Code config with a stub server, check that it is linked or unlinked, and probe it over MCP. |

Line endings are pinned in `.gitattributes`: CRLF for the Windows scripts, LF for the shell scripts.

## Building the Linux packages locally

Needs `dpkg-deb` (Debian/Ubuntu: `dpkg`; Arch: `dpkg` from the repos), `curl`, and for the
Arch package `makepkg`.

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm -s exec tsx packaging/stage.ts build/stage
sh packaging/linux/fetch-node.sh build/stage x64

sh packaging/linux/build-deb.sh build/stage build/out "$(pnpm -s exec tsx packaging/version.ts deb)" amd64
sh packaging/linux/build-tarball.sh build/stage build/out "$(pnpm -s exec tsx packaging/version.ts semver)" x64
```

For the Arch package, follow the **Build Arch/CachyOS package** step in the workflow.
`build/` is gitignored.

Use `pnpm -s exec`: pnpm 11 reports its install check on stdout, which would end up inside `$(...)`.

## Building the Windows installer locally

On Windows, with Inno Setup 6.3 or newer:

```powershell
pnpm install --frozen-lockfile; pnpm build
pnpm -s exec tsx packaging/stage.ts build\stage
./packaging/windows/fetch-node.ps1 -Destination "$PWD\build\stage"
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" "/DAppVersion=$(pnpm -s exec tsx packaging/version.ts semver)" `
  "/DFileVersion=$(pnpm -s exec tsx packaging/version.ts windows)" "/DStageDir=$PWD\build\stage" "/DOutputDir=$PWD\build\out" `
  packaging\windows\latchverify.iss
```

## Smoke-testing an install

The workflow does this for every package. To repeat it by hand on a machine where Claude Code's
config can be overwritten (a VM or a throwaway user):

```sh
check="pnpm -s exec tsx packaging/test/check-link.ts"
$check client   --config ~/.claude.json --server stub     # overwrites ~/.claude.json
# install the package
$check linked   --config ~/.claude.json --lockfile ~/.config/latchverify/latch.lock --server stub
$check probe    --config ~/.claude.json --server stub --tool echo
# uninstall the package
$check unlinked --config ~/.claude.json --lockfile ~/.config/latchverify/latch.lock --server stub
```
