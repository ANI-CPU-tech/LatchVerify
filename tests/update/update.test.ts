import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installersByKind, makeManifest } from "../../packaging/make-latest-json.js";
import { INSTALL_KIND_FILE, checkForUpdate, download, installCommand, installKind, isNewer, signatureValid, signedMessage, updateUrl, type Offer } from "../../src/update/index.js";

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};
const { publicKey, privateKey } = keys();
const fetchJson = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const sha = "a".repeat(64);
const manifest = (version: string, signer = privateKey) => ({
  version,
  notes: "Fixes.",
  pub_date: "2026-10-29T09:00:00.000Z",
  platforms: {
    "linux-x86_64-deb": {
      url: "https://github.com/ANI-CPU-tech/LatchVerify/releases/download/v9.9.9/latchverify_9.9.9_amd64.deb",
      sha256: sha,
      signature: sign(null, Buffer.from(signedMessage(version, "linux-x86_64-deb", sha)), signer).toString("base64"),
    },
  },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-update-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("versions and signatures", () => {
  it("offers only a newer release, never a pre-release", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0-rc.1", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "0.2.0-rc.1")).toBe(false);
  });

  it("accepts only the release key's signature of exactly that message", () => {
    const message = signedMessage("1.0.0", "linux-x86_64-deb", sha);
    const signature = sign(null, Buffer.from(message), privateKey).toString("base64");
    expect(signatureValid(message, signature, publicKey)).toBe(true);
    expect(signatureValid(message.replace("1.0.0", "1.0.1"), signature, publicKey)).toBe(false);
    expect(signatureValid(message, signature, keys().publicKey)).toBe(false);
    expect(signatureValid(message, "not base64 at all", publicKey)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("offers a newer, signed release for the install kind", async () => {
    const offer = await checkForUpdate("deb", { current: "0.1.0", publicKey, fetch: fetchJson(manifest("9.9.9")) });
    expect(offer).toMatchObject({ version: "9.9.9", kind: "deb", sha256: sha, notes: "Fixes." });
  });

  it("offers nothing when up to date or when the release has no file for this kind", async () => {
    expect(await checkForUpdate("deb", { current: "9.9.9", publicKey, fetch: fetchJson(manifest("9.9.9")) })).toBeUndefined();
    expect(await checkForUpdate("inno", { current: "0.1.0", publicKey, fetch: fetchJson(manifest("9.9.9")) })).toBeUndefined();
  });

  it("refuses a release signed with another key, an invalid manifest and a failed fetch", async () => {
    await expect(checkForUpdate("deb", { current: "0.1.0", publicKey, fetch: fetchJson(manifest("9.9.9", keys().privateKey)) })).rejects.toThrow("signature for linux-x86_64-deb is not the release key's");
    await expect(checkForUpdate("deb", { current: "0.1.0", publicKey, fetch: fetchJson({ version: "9.9.9" }) })).rejects.toThrow("not valid");
    await expect(checkForUpdate("deb", { current: "0.1.0", publicKey, fetch: fetchJson({}, 404) })).rejects.toThrow("HTTP 404");
    const http = { ...manifest("9.9.9"), platforms: { "linux-x86_64-deb": { ...manifest("9.9.9").platforms["linux-x86_64-deb"], url: "http://example.com/x.deb" } } };
    await expect(checkForUpdate("deb", { current: "0.1.0", publicKey, fetch: fetchJson(http) })).rejects.toThrow("not valid");
  });

  it("reads the update URL from LATCH_UPDATE_URL only in development mode", () => {
    expect(updateUrl({ LATCH_UPDATE_URL: "http://127.0.0.1:1/latest.json" })).toBe("https://github.com/ANI-CPU-tech/LatchVerify/releases/latest/download/latest.json");
    expect(updateUrl({ LATCH_DEV: "1", LATCH_UPDATE_URL: "http://127.0.0.1:1/latest.json" })).toBe("http://127.0.0.1:1/latest.json");
  });
});

describe("downloading and installing", () => {
  const offer = (sha256: string): Offer => ({ version: "9.9.9", notes: "", kind: "deb", url: "https://example.com/latchverify_9.9.9_amd64.deb", sha256, signature: "x" });
  const fetchBytes = (bytes: string) => (async () => new Response(bytes)) as unknown as typeof fetch;

  it("keeps a download only when its sha256 is the signed one", async () => {
    const good = "a7d1b0d1f2a6c3b1de6d73c86f3f1f2bdcfe5b8f0e2fa2c4b0e9c8d6a5e4f3b2";
    const bytes = "the package";
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update(bytes).digest("hex");
    const file = await download(offer(real), fetchBytes(bytes));
    expect(await readFile(file, "utf8")).toBe(bytes);
    await rm(join(file, ".."), { recursive: true, force: true });
    await expect(download(offer(good), fetchBytes(bytes))).rejects.toThrow("does not match its signed checksum");
  });

  it("installs each kind its own way", () => {
    expect(installCommand("inno", "C:\\t\\setup.exe", "C:\\app")).toEqual({ command: "C:\\t\\setup.exe", args: ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/NORESTART"] });
    expect(installCommand("deb", "/t/x.deb", "/usr/lib/latchverify")).toEqual({ command: "pkexec", args: ["apt-get", "install", "-y", "/t/x.deb"] });
    expect(installCommand("pacman", "/t/x.pkg.tar.zst", "/usr/lib/latchverify")).toEqual({ command: "pkexec", args: ["pacman", "-U", "--noconfirm", "/t/x.pkg.tar.zst"] });
    const tarball = installCommand("tarball", "/t/x.tar.gz", "/home/me/.local/lib/latchverify");
    expect(tarball.args.slice(-2)).toEqual(["/t/x.tar.gz", "/home/me/.local"]);
  });

  it("finds the install kind its installer left, and none in a source checkout", async () => {
    await mkdir(join(dir, "app", "dist", "update"), { recursive: true });
    await writeFile(join(dir, INSTALL_KIND_FILE), "pacman\n");
    expect(installKind(join(dir, "app", "dist", "update", "index.js"))).toEqual({ kind: "pacman", root: dir });
    expect(installKind()).toBeUndefined();
  });
});

describe("make-latest-json", () => {
  it("signs every installer so the apps accept the manifest, and refuses a pre-release", async () => {
    const files = ["latchverify-1.2.3-windows-x64-setup.exe", "latchverify_1.2.3_amd64.deb", "latchverify-bin-1.2.3-1-x86_64.pkg.tar.zst", "latchverify-1.2.3-linux-x64.tar.gz", "SHA256SUMS"];
    for (const file of files) await writeFile(join(dir, file), `contents of ${file}`);
    expect(installersByKind(files).deb).toBe("latchverify_1.2.3_amd64.deb");
    const latest = makeManifest("1.2.3", dir, privateKey, "## 1.2.3\n\nFixed things.\n", new Date("2026-10-29T09:00:00.000Z"));
    expect(latest.notes).toBe("Fixed things.");
    expect(Object.keys(latest.platforms).sort()).toEqual(["linux-x86_64-deb", "linux-x86_64-pacman", "linux-x86_64-tarball", "windows-x86_64-inno"]);
    for (const kind of ["inno", "deb", "pacman", "tarball"] as const) {
      expect(await checkForUpdate(kind, { current: "1.2.2", publicKey, fetch: fetchJson(latest) })).toMatchObject({ version: "1.2.3", kind });
    }
    expect(() => makeManifest("1.2.4-rc.1", dir, privateKey, "", new Date())).toThrow("pre-release");
    expect(() => installersByKind(files.slice(1))).toThrow("expected one inno installer, found 0");
  });
});
