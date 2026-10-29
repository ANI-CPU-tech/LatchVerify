import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { UPDATE_PUBLIC_KEY } from "./key.js";
import { INSTALL_KINDS, ManifestSchema, PLATFORM_KEYS, isNewer, signedMessage, type InstallKind, type Manifest } from "./manifest.js";

export * from "./manifest.js";

/** Where releases publish latest.json. */
export const UPDATE_URL = "https://github.com/ANI-CPU-tech/LatchVerify/releases/latest/download/latest.json";
/** The marker each installer writes next to the app: its install kind. */
export const INSTALL_KIND_FILE = "install-kind";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** The update a release offers this install. */
export interface Offer {
  version: string;
  notes: string;
  kind: InstallKind;
  url: string;
  sha256: string;
  signature: string;
}

/**
 * This install's kind, from the INSTALL_KIND_FILE an installer put up to five folders above this
 * module (it differs between the CLI and the desktop app). Undefined in a source checkout, where
 * updates are off.
 */
export function installKind(from: string = fileURLToPath(import.meta.url)): { kind: InstallKind; root: string } | undefined {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    const marker = join(dir, INSTALL_KIND_FILE);
    if (existsSync(marker)) {
      const kind = readFileSync(marker, "utf8").trim();
      return (INSTALL_KINDS as readonly string[]).includes(kind) ? { kind: kind as InstallKind, root: dir } : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The URL latest.json is fetched from: UPDATE_URL, or LATCH_UPDATE_URL in development mode only (tests). */
export function updateUrl(env: NodeJS.ProcessEnv = process.env): string {
  const dev = /^(1|true|yes|on)$/i.test(env.LATCH_DEV?.trim() ?? "");
  return dev && env.LATCH_UPDATE_URL?.trim() ? env.LATCH_UPDATE_URL.trim() : UPDATE_URL;
}

/** True when `signature` (base64) is the release key's ed25519 signature of `message`. */
export function signatureValid(message: string, signature: string, publicKey: string = UPDATE_PUBLIC_KEY): boolean {
  try {
    return verify(null, Buffer.from(message, "utf8"), createPublicKey(publicKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * The update latest.json offers `kind`, newer than `current` and signed by the release key, or
 * undefined when there is none. Never downloads the file itself.
 *
 * @throws Error when the manifest cannot be fetched or is invalid, or the signature is wrong.
 */
export async function checkForUpdate(kind: InstallKind, options: { url?: string; current?: string; fetch?: typeof fetch; publicKey?: string } = {}): Promise<Offer | undefined> {
  const response = await (options.fetch ?? fetch)(options.url ?? updateUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new Error(`could not fetch the update manifest: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error("the update manifest is too large");
  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("the update manifest is not valid");
  }
  if (!isNewer(manifest.version, options.current ?? VERSION)) return undefined;
  const key = PLATFORM_KEYS[kind];
  const asset = manifest.platforms[key];
  if (asset === undefined) return undefined;
  if (!signatureValid(signedMessage(manifest.version, key, asset.sha256), asset.signature, options.publicKey)) {
    throw new Error(`the update manifest's signature for ${key} is not the release key's; not offering ${manifest.version}`);
  }
  return { version: manifest.version, notes: manifest.notes, kind, ...asset };
}

/**
 * Downloads `offer` into a new temp folder and checks its sha256 (the signed one) before anything
 * runs it. Resolves the file's path.
 */
export async function download(offer: Offer, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(offer.url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`could not download ${offer.url}: HTTP ${response.status}`);
  const dir = await mkdtemp(join(tmpdir(), "latchverify-update-"));
  const file = join(dir, decodeURIComponent(new URL(offer.url).pathname.split("/").pop() || "update"));
  const hash = createHash("sha256");
  let size = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) body.destroy(new Error("the update is larger than any LatchVerify release"));
    hash.update(chunk);
  });
  try {
    await pipeline(body, createWriteStream(file, { mode: 0o700 }));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  if (hash.digest("hex") !== offer.sha256) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("the downloaded update does not match its signed checksum; nothing was installed");
  }
  return file;
}

/** How each install kind installs a downloaded, verified update: the program and its arguments. */
export function installCommand(kind: InstallKind, file: string, root: string): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  switch (kind) {
    case "inno":
      // Closes the running app (and proxies) and restarts it afterwards; the installer's own [Run] relaunches.
      return { command: file, args: ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/NORESTART"] };
    case "deb":
      return { command: "pkexec", args: ["apt-get", "install", "-y", file] };
    case "pacman":
      return { command: "pkexec", args: ["pacman", "-U", "--noconfirm", file] };
    case "tarball":
      // The new archive's own install.sh, into the same prefix (<prefix>/lib/latchverify is `root`).
      return { command: "sh", args: ["-c", 'set -e; d=$(mktemp -d); tar -xzf "$1" -C "$d"; LATCH_SKIP_SETUP=1 PREFIX="$2" "$d"/*/install.sh; rm -rf "$d"', "latch-update", file, dirname(dirname(root))] };
  }
}

/** Runs the install. Resolves its exit code; the Inno installer is left running, detached (it replaces this process). */
export function runInstall(kind: InstallKind, file: string, root: string): Promise<number> {
  const { command, args, env } = installCommand(kind, file, root);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: env ?? process.env, detached: kind === "inno", windowsHide: false });
    child.once("error", reject);
    if (kind === "inno") {
      child.unref();
      resolve(0);
    } else child.once("exit", (code) => resolve(code ?? 1));
  });
}
