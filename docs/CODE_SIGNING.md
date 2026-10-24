# Signing the Windows installer

Windows shows "Windows protected your PC" (SmartScreen) for installers that aren't signed with a code-signing certificate. Code cannot remove this by itself: you need a certificate issued to you (or your organization) by a certificate authority that Windows trusts. A self-signed certificate does **not** help.

The build workflow is already set up to sign as soon as a certificate is available. Until then it builds an unsigned installer and prints a warning.

## What signing changes

- The installer shows your name as the **verified publisher** instead of "Unknown publisher".
- SmartScreen warnings fade as the signed installer gains reputation (downloads without reports). A brand-new certificate can still trigger a warning for the first releases; that's how SmartScreen works for everyone.
- Users can verify the files weren't tampered with.

The workflow signs both the setup EXE and the uninstaller it installs (`unins000.exe`). The bundled `node.exe` is already signed by the Node.js project and is shipped as downloaded, after its SHA-256 is checked against nodejs.org.

## Ways to get a certificate

| Option | Cost (approx.) | Notes |
|---|---|---|
| **SignPath Foundation** | Free | For open-source projects. Apply at signpath.org; they sign builds from your public GitHub repository through their own service, so you'd follow their GitHub Actions integration instead of the `.pfx` steps below. |
| **Certum Open Source Code Signing** | Low annual fee | Certificate for individual open-source developers, delivered on a smart card/cloud key. |
| **Azure Trusted Signing** | Monthly subscription | Microsoft's managed signing. Requires identity validation; check eligibility for your country and whether you're an individual or organization. Signs through a command-line tool rather than a `.pfx`. |
| Commercial OV certificate (Sectigo, DigiCert, SSL.com…) | Annual fee | Organization validation. Since 2023, new certificates are issued on hardware tokens or cloud HSMs, so a downloadable `.pfx` may not be available. Check the CA's CI/CD signing option. |

Prices and eligibility change; check the provider's current terms.

## Using a `.pfx` certificate with the workflow

If your provider gives you a `.pfx` file:

1. Convert it to base64:
   - Linux/macOS: `base64 -w0 certificate.pfx > certificate.txt`
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Content certificate.txt`
2. On GitHub, open the repository → **Settings → Secrets and variables → Actions → New repository secret**:
   - `WINDOWS_CERTIFICATE`: the contents of `certificate.txt`
   - `WINDOWS_CERTIFICATE_PASSWORD`: the `.pfx` password
3. Delete `certificate.txt`. Never commit the certificate.
4. Run **Build installers** again. The log says "Signing the installer with certificate …", and the setup EXE and its uninstaller are signed with SHA-256 and timestamped.

To check a downloaded installer on Windows: right-click it → **Properties → Digital Signatures**, or run `Get-AuthenticodeSignature latchverify-<version>-windows-x64-setup.exe`.

## How the workflow signs

The certificate is imported into the runner's `Cert:\CurrentUser\My` store, and Inno Setup is given a sign tool named `latchsign` that runs the Windows SDK's `signtool.exe` with that certificate's thumbprint:

```
ISCC /DSignTool=1 "/Slatchsign=$qC:\...\signtool.exe$q sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint> $f" ...
```

`/DSignTool=1` turns on `SignTool=latchsign` and `SignedUninstaller=yes` in `packaging/windows/latchverify.iss`. Inno Setup replaces `$f` with the file to sign and `$q` with a quote.

## Using a cloud or hardware-token certificate

Inno Setup can call any signing tool: only the `/Slatchsign=` command changes (for example Azure Trusted Signing's `signtool` dlib, or your CA's cloud signing tool, with `$f` as the file). Follow your provider's instructions for a GitHub Actions runner and replace the signing branch of the **Build the installer** step in `.github/workflows/build-installers.yml`.

## Until then

Tell users to click **More info → Run anyway**. `INSTALL.md` already explains this.
