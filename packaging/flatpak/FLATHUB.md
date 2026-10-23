# Flathub submission (not done)

LatchVerify is **not** on Flathub. `pnpm package flatpak` builds a local `.flatpak` bundle
from the prebuilt portable archive, for testing on your own machine. Flathub does not accept
that manifest as is: it builds every app from source on its own infrastructure.

## What a submission needs

1. **An app id you control.** `io.github.vinayakkam.LatchVerify` (scripts/package/config.ts
   `APP_ID`) maps to `github.com/vinayakkam/LatchVerify`. The code lives in
   `vinayakkam/Nexathon2026`, so either move it to a `LatchVerify` repository or change the id
   to `io.github.vinayakkam.Nexathon2026` everywhere (`APP_ID`, metainfo `<id>`, desktop file
   name).
2. **A source build.** Replace the `archive` source with the git repository at a release tag
   and commit. Then run
   `flatpak-node-generator pnpm pnpm-lock.yaml -o generated-sources.json --no-devel` (from
   flatpak-builder-tools) so pnpm installs offline inside the build. The build commands become
   `pnpm install --offline --frozen-lockfile`, `pnpm build`, and the same staging as
   scripts/package/stage.ts.
3. **AppStream metadata** that passes `flatpak run --command=flatpak-builder-lint
   org.flatpak.Builder appstream <file>`. Add at least one `<screenshot>` of the review UI and a
   `<release>` entry per version. packaging/linux/latchverify.metainfo.xml.in already validates
   with `appstreamcli validate`.
4. **Justified permissions.** `--share=network` lets the host browser reach the review server
   on 127.0.0.1. `--filesystem=home` gives access to projects with `latch.lock`; Flathub
   reviewers prefer narrower access, so consider documenting `flatpak override` for project
   directories instead.
5. **Scope stated plainly.** Inside the sandbox, `latch proxy` cannot start MCP servers
   installed on the host. The Flatpak is useful for the review UI, `latch verify` and
   `latch inspect --file`; the description must say so.
6. **The pull request**, opened by a maintainer against `flathub/flathub` (branch
   `new-pr`) with the manifest and generated sources. That is a publishing step, outside
   scripts/package.

## Local test

```sh
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
  org.freedesktop.Sdk.Extension.node22//24.08
pnpm package flatpak --version 0.1.0
flatpak install --user build/packages/0.1.0/flatpak/latchverify-0.1.0.flatpak
```
