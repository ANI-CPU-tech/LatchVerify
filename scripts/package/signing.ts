import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { which } from "./process.js";

/**
 * Windows Authenticode signing for the installer (and the uninstaller Inno Setup embeds).
 *
 * Smart App Control and SmartScreen trust only signatures that chain to a root in Microsoft's
 * Trusted Root Program; a self-signed certificate is never accepted. Two ways to sign, both set
 * from the environment (CI secrets), never from the UI:
 *
 *   LATCH_WIN_SIGN_THUMBPRINT   SHA-1 thumbprint of a certificate in the CurrentUser or
 *                               LocalMachine "My" store (an OV/EV certificate from a CA).
 *   LATCH_WIN_SIGN_DLIB +       Azure Artifact Signing (formerly Trusted Signing):
 *   LATCH_WIN_SIGN_METADATA     Azure.CodeSigning.Dlib.dll and its metadata.json.
 *
 *   LATCH_WIN_SIGN_TIMESTAMP_URL  RFC 3161 timestamp server (optional).
 *   LATCH_WIN_SIGN_REQUIRED=1     fail the build instead of producing an unsigned installer.
 */
export type WindowsSigning =
  | { mode: "none" }
  | { mode: "thumbprint"; thumbprint: string; timestampUrl: string }
  | { mode: "artifact-signing"; dlib: string; metadata: string; timestampUrl: string };

const DIGICERT_TIMESTAMP = "http://timestamp.digicert.com";
/** Artifact Signing certificates live three days; timestamping keeps signatures valid after that. */
const ARTIFACT_SIGNING_TIMESTAMP = "http://timestamp.acs.microsoft.com";

/** Characters that would break out of the quoted command Inno Setup runs ($ starts an Inno variable). */
const UNSAFE = /["$\r\n]/;

function timestamp(env: NodeJS.ProcessEnv, fallback: string): string {
  const url = env.LATCH_WIN_SIGN_TIMESTAMP_URL?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`LATCH_WIN_SIGN_TIMESTAMP_URL is not a URL: ${JSON.stringify(url)}`);
  }
  if (!/^https?:$/.test(parsed.protocol) || /[\s"$]/.test(url)) throw new Error(`LATCH_WIN_SIGN_TIMESTAMP_URL must be a plain http(s) URL, got ${JSON.stringify(url)}`);
  return url;
}

function existingFile(name: string, value: string, expectedBase?: RegExp): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
  if (UNSAFE.test(value)) throw new Error(`${name} must not contain quotes or $`);
  if (expectedBase && !expectedBase.test(basename(value))) throw new Error(`${name} must point to ${expectedBase.source.replace(/\\/g, "")}`);
  if (!existsSync(value)) throw new Error(`${name} does not exist: ${value}`);
  return value;
}

/** The signing configuration from the environment. Throws on a set but invalid configuration. */
export function windowsSigning(env: NodeJS.ProcessEnv = process.env): WindowsSigning {
  const thumbprint = env.LATCH_WIN_SIGN_THUMBPRINT?.trim();
  const dlib = env.LATCH_WIN_SIGN_DLIB?.trim();
  const metadata = env.LATCH_WIN_SIGN_METADATA?.trim();
  if (thumbprint && (dlib || metadata)) throw new Error("set LATCH_WIN_SIGN_THUMBPRINT or LATCH_WIN_SIGN_DLIB/LATCH_WIN_SIGN_METADATA, not both");
  if (thumbprint) {
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw new Error("LATCH_WIN_SIGN_THUMBPRINT must be a 40-character SHA-1 thumbprint");
    return { mode: "thumbprint", thumbprint: thumbprint.toUpperCase(), timestampUrl: timestamp(env, DIGICERT_TIMESTAMP) };
  }
  if (dlib || metadata) {
    if (!dlib || !metadata) throw new Error("Artifact Signing needs both LATCH_WIN_SIGN_DLIB and LATCH_WIN_SIGN_METADATA");
    const meta = existingFile("LATCH_WIN_SIGN_METADATA", metadata, /\.json$/);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`LATCH_WIN_SIGN_METADATA is not valid JSON: ${meta}`);
    }
    for (const field of ["Endpoint", "CodeSigningAccountName", "CertificateProfileName"]) {
      if (typeof parsed[field] !== "string" || parsed[field] === "") throw new Error(`Artifact Signing metadata needs a "${field}" string`);
    }
    if (!String(parsed.Endpoint).startsWith("https://")) throw new Error("Artifact Signing metadata Endpoint must be an https URL");
    return {
      mode: "artifact-signing",
      dlib: existingFile("LATCH_WIN_SIGN_DLIB", dlib, /^Azure\.CodeSigning\.Dlib\.dll$/i),
      metadata: meta,
      timestampUrl: timestamp(env, ARTIFACT_SIGNING_TIMESTAMP),
    };
  }
  return { mode: "none" };
}

export const signingRequired = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes)$/i.test(env.LATCH_WIN_SIGN_REQUIRED?.trim() ?? "");

/** signtool.exe: on PATH, else the newest x64 copy in the Windows 10/11 SDK. */
export function findSigntool(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = which("signtool", env);
  if (onPath) return onPath;
  const kits = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  let versions: string[] = [];
  try {
    versions = readdirSync(kits).filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name));
  } catch {
    return null;
  }
  const byVersion = (a: string, b: string) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  };
  for (const version of versions.sort(byVersion)) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** signtool arguments that sign one file (without the file). */
export function signArguments(signing: Exclude<WindowsSigning, { mode: "none" }>): string[] {
  const common = ["sign", "/fd", "SHA256", "/tr", signing.timestampUrl, "/td", "SHA256"];
  return signing.mode === "thumbprint"
    ? [...common, "/sha1", signing.thumbprint]
    : [...common, "/dlib", signing.dlib, "/dmdf", signing.metadata];
}

/**
 * The sign command Inno Setup runs for the installer and uninstaller (ISCC /S). Inno replaces
 * $q with a quote and $f with the quoted file to sign; every value was validated above, so none
 * contains a quote or $.
 */
export function innoSignCommand(signtool: string, signing: Exclude<WindowsSigning, { mode: "none" }>): string {
  if (UNSAFE.test(signtool)) throw new Error("signtool path must not contain quotes or $");
  const args = signArguments(signing).map((arg) => (/\s/.test(arg) ? `$q${arg}$q` : arg));
  return [`$q${signtool}$q`, ...args, "$f"].join(" ");
}
