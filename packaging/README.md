# Packaging LatchVerify

LatchVerify is a Node.js command-line tool with a local web review UI. Every package holds the
same pure-JavaScript app: `dist/`, the built UI, and production `node_modules` installed
offline from the pnpm store. So one package per format runs on every CPU architecture, and
every package needs **Node.js 22 or newer** at run time.

## Build

From a checkout, after `pnpm install`:

```sh
pnpm package --list                          # targets and what this machine lacks
pnpm package --check arch --version 0.1.0    # prerequisites + packaging file validation
pnpm package arch --version 0.1.0            # build, verify, write checksums
pnpm package --release 0.1.0                 # RELEASE_NOTES.md + SHA256SUMS for all builds
```

Or run `pnpm ui` and use **Build & Distribution** in the web UI. It runs the same code
(scripts/package) through a development-only API that `latch review --ui` never serves.

Output: `build/packages/<version>/<target>/` holds the package, `SHA256SUMS`, `INSTALL.md`,
`build.json` and `build.log`. Job records are in `build/packages/.jobs/`, and failed builds
keep their scratch files in `build/packages/.work/<id>/`. A build counts as successful only if
every prerequisite, validation and verification check passed.

| Target | Output | Builds on | Needs |
|---|---|---|---|
| `linux-tarball` | `latchverify-<v>-linux-portable.tar.gz` | Linux | GNU tar |
| `windows-zip` | `latchverify-<v>-windows-portable.zip` | Linux, Windows, macOS | bsdtar (Windows: built-in `tar`) |
| `windows-installer` | `latchverify-<v>-windows-setup.exe` | Windows | Inno Setup 6; signtool + a certificate to sign |
| `arch` | `latchverify-<v>-1-any.pkg.tar.zst` (+ PKGBUILD) | Arch, CachyOS | makepkg, fakeroot |
| `deb` | `latchverify_<v>-1_all.deb` | Linux | dpkg-deb |
| `flatpak` | `latchverify-<v>.flatpak` (local only) | Linux | flatpak-builder, freedesktop 24.08 runtime + SDK + node22 extension |

All targets need pnpm and a prior `pnpm install`. Optional validators run when installed and
are reported as skipped otherwise: `desktop-file-validate`, `appstreamcli`, `namcap`, `lintian`.

**Releases** are built and published by GitHub Actions when you push a `v*` tag:
`.github/workflows/release.yml` runs `package.yml` (every target, each on a native runner),
signs, and creates the GitHub Release. See [RELEASING.md](RELEASING.md), which also covers
setting up Windows code signing.

`pnpm package --release <v>` collects the successful builds into
`build/packages/<v>/release/` (each file once, SHA256SUMS, and SHA256SUMS.asc when
`LATCH_GPG_KEY_ID` is set) and writes `RELEASE_NOTES.md`.

**Windows signing:** Smart App Control and SmartScreen block unsigned installers and accept
only certificates that chain to Microsoft's Trusted Root Program. Set
`LATCH_WIN_SIGN_THUMBPRINT`, or `LATCH_WIN_SIGN_DLIB` + `LATCH_WIN_SIGN_METADATA` (Azure
Artifact Signing). `LATCH_WIN_SIGN_REQUIRED=1` fails an unsigned build.

Maintainer metadata: set `LATCH_PACKAGER="Name <email>"`; it defaults to a neutral
"LatchVerify contributors" address.

## What each package installs

- **Linux** (tarball, Arch, Debian, Flatpak):
  - `bin/latch`
  - `bin/latchverify-review`, the desktop launcher
  - `lib/latchverify/`
  - a desktop entry `io.github.vinayakkam.LatchVerify.desktop` (Terminal=true)
  - hicolor icons at 16–512 px plus SVG
  - AppStream metainfo
- **Windows** (zip, installer):
  - `latch.cmd`
  - `LatchVerify Review.cmd`
  - `latchverify.ico`
  - `app/`

  The installer is per-user. It adds a Start menu shortcut and, optionally, a PATH entry, which
  the uninstaller removes again.

The launchers run `latch review --ui`. Started from a menu, they ask for the project directory
that holds `latch.lock` unless `LATCH_LOCKFILE_PATH` is set. `latch init` writes MCP client
configs that start `latch`, so `latch` must be on PATH. Native packages and the installer's
PATH option take care of that; the portable archives document it.

## Not provided

- **AppImage.** An AppImage must bundle the Node.js runtime and needs `appimagetool`. Neither
  is in this repository, and fetching them would mean downloading and running third-party
  binaries during the build. The portable archive covers the same "any distribution" case.
- **Per-package Linux signatures.** The `.deb` and `.pkg.tar.zst` are not individually
  signed (`debsigs`, pacman `.sig`). Release integrity comes from `SHA256SUMS`, its GPG
  signature and GitHub build-provenance attestations. Distribute through a signed apt or
  pacman repository if you need per-package signatures.
- **A signed Windows zip.** Windows blocks `.cmd` files extracted from a downloaded zip
  under Smart App Control; use the signed installer there.
- **Flathub publication.** See [flatpak/FLATHUB.md](flatpak/FLATHUB.md).
