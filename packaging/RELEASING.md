# Releasing LatchVerify

Releases are built and published by GitHub Actions. You push a version tag; the workflows
build every package on native runners, sign what can be signed, and create the GitHub
Release. Nothing on your machine uploads anything.

## Cut a release

```sh
git switch main && git pull
git tag -a v1.2.0 -m "LatchVerify 1.2.0"     # v1.2.0-rc.1 makes a pre-release
git push origin v1.2.0
```

`.github/workflows/release.yml` then runs these steps:

1. **package.yml** builds every package on a native runner:

   | Runner | Packages |
   |---|---|
   | Ubuntu | `latchverify-<v>-linux-portable.tar.gz`, `latchverify_<v>-1_all.deb`, `latchverify-<v>-windows-portable.zip` |
   | Arch Linux container (Arch, CachyOS, Manjaro) | `latchverify-<v>-1-any.pkg.tar.zst` and its `PKGBUILD` |
   | Ubuntu with flatpak-builder | `latchverify-<v>.flatpak` and its manifest |
   | Windows | `latchverify-<v>-windows-setup.exe`, Authenticode-signed |

   Each build checks its prerequisites, validates its packaging files, and verifies the
   result before it counts as a success.
2. **`pnpm package --release <v>`** collects the packages into `release/`, writes
   `SHA256SUMS`, and signs it as `SHA256SUMS.asc` if a GPG key is configured. It writes
   release notes covering downloads, the changes since the previous tag, and how to verify.
3. **Build provenance:** `actions/attest-build-provenance` signs an attestation for every
   file, so anyone can check that it was built by this repository's workflow:
   `gh attestation verify <file> --repo <owner>/<repo>`.
4. **`gh release create`** publishes the files. The tag must already exist (`--verify-tag`),
   and a version with a `-suffix` is marked as a pre-release.

To build without releasing, run the **package** workflow by hand (Actions > package > Run
workflow). The packages stay as workflow artifacts.

## Windows code signing (required for releases)

Smart App Control (Windows 11) and Microsoft Defender SmartScreen block unsigned
installers. They accept only signatures that chain to a root in Microsoft's Trusted Root
Program. **A self-signed certificate never works**, not even one imported on the target
machine. The release workflow therefore fails if the installer is not signed.

Configure one of the two methods below in **Settings > Secrets and variables > Actions**.

### Option A: Azure Artifact Signing (recommended)

Microsoft's managed signing service (formerly Trusted Signing). The keys stay in Azure,
nothing secret is stored in GitHub, and the certificates are trusted by Smart App Control.

1. In Azure, create an **Artifact Signing account**, complete identity validation, and create
   a **Public Trust certificate profile**.
2. Create an app registration (or a user-assigned managed identity) with a **federated
   credential** for this repository's GitHub Actions. Use subject
   `repo:<owner>/<repo>:ref:refs/tags/*` for tag releases, plus any branches you build from
   by hand. Assign it the **Artifact Signing Certificate Profile Signer** role on the
   account.
3. Add **secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
4. Add **variables**: `AZURE_SIGNING_ENDPOINT` (for example
   `https://eus.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`.

### Option B: a code-signing certificate from a CA

You need an OV or EV code-signing certificate that you can export as a `.pfx`. Recent
certificates on a hardware token (HSM) cannot be exported; use the CA's cloud-signing
service with Option A's pattern instead.

```sh
base64 -w0 certificate.pfx > certificate.pfx.b64   # paste into the secret
```

- Secret `WINDOWS_CERTIFICATE_PFX_BASE64`: the base64 text.
- Secret `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password.

The workflow imports the certificate into the runner's user store, signs by thumbprint, and
removes it afterwards.

### Either way

- Inno Setup signs both the installer and the uninstaller inside it, with SHA-256 digests and
  an RFC 3161 timestamp, so signatures stay valid after the certificate expires.
- The build then runs `signtool verify /pa /all` and fails if the signature does not chain to
  a trusted root.
- A brand-new certificate can still show a SmartScreen "unrecognized app" prompt until the
  publisher builds reputation. Smart App Control checks the signature itself.
- To release without a signed installer (not recommended: Smart App Control blocks it), set
  the variable `LATCH_ALLOW_UNSIGNED_WINDOWS=true`. The release notes then flag the
  installer as unsigned.
- The Windows **zip** cannot satisfy Smart App Control. Windows blocks `.cmd` files
  extracted from a downloaded zip, signed or not. The installer is the supported route on
  machines with Smart App Control.

To sign locally on Windows, set `LATCH_WIN_SIGN_THUMBPRINT` (a certificate in your store),
or `LATCH_WIN_SIGN_DLIB` and `LATCH_WIN_SIGN_METADATA`, before
`pnpm package windows-installer`.

## Checksum signing with GPG (optional)

```sh
gpg --quick-gen-key "LatchVerify Releases <releases@example.com>" ed25519 sign 2y
gpg --armor --export-secret-keys <fingerprint>   # paste into the secret
gpg --armor --export <fingerprint> > latchverify-release-key.asc   # publish this
```

- Secret `RELEASE_GPG_PRIVATE_KEY`: the armored private key.
- Secret `RELEASE_GPG_PASSPHRASE`: its passphrase, if it has one. It is passed to gpg on
  stdin.

Publish the public key (README, keyserver) so users can run
`gpg --verify SHA256SUMS.asc SHA256SUMS`.

## Verifying a release (for users)

```sh
sha256sum --ignore-missing -c SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS                                 # when present
gh attestation verify latchverify-1.2.0-1-any.pkg.tar.zst --repo <owner>/<repo>
```

On Windows: right-click the installer > Properties > Digital Signatures.
