import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { innoSignCommand, signArguments, signingRequired, windowsSigning } from "../../scripts/package/signing.js";
import { TARGETS } from "../../scripts/package/targets.js";

const THUMB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
let dir: string;
let dlib: string;
let metadata: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch sign-"));
  dlib = join(dir, "Azure.CodeSigning.Dlib.dll");
  metadata = join(dir, "metadata.json");
  await writeFile(dlib, "");
  await writeFile(metadata, JSON.stringify({ Endpoint: "https://eus.codesigning.azure.net", CodeSigningAccountName: "acct", CertificateProfileName: "prof" }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("windowsSigning", () => {
  it("is off when nothing is configured", () => {
    expect(windowsSigning({})).toEqual({ mode: "none" });
  });

  it("reads a certificate thumbprint, with the default timestamp server", () => {
    expect(windowsSigning({ LATCH_WIN_SIGN_THUMBPRINT: THUMB })).toEqual({ mode: "thumbprint", thumbprint: THUMB.toUpperCase(), timestampUrl: "http://timestamp.digicert.com" });
  });

  it("reads an Azure Artifact Signing setup, timestamped by Microsoft", () => {
    expect(windowsSigning({ LATCH_WIN_SIGN_DLIB: dlib, LATCH_WIN_SIGN_METADATA: metadata })).toEqual({
      mode: "artifact-signing",
      dlib,
      metadata,
      timestampUrl: "http://timestamp.acs.microsoft.com",
    });
  });

  it.each([
    [{ LATCH_WIN_SIGN_THUMBPRINT: "abc" }, "40-character"],
    [{ LATCH_WIN_SIGN_THUMBPRINT: THUMB, LATCH_WIN_SIGN_DLIB: "/x" }, "not both"],
    [{ LATCH_WIN_SIGN_DLIB: "/x/Azure.CodeSigning.Dlib.dll" }, "needs both"],
    [{ LATCH_WIN_SIGN_THUMBPRINT: THUMB, LATCH_WIN_SIGN_TIMESTAMP_URL: "ftp://ts" }, "http(s)"],
    [{ LATCH_WIN_SIGN_THUMBPRINT: THUMB, LATCH_WIN_SIGN_TIMESTAMP_URL: 'http://ts" /p x' }, "LATCH_WIN_SIGN_TIMESTAMP_URL"],
  ])("rejects %j", (env, message) => {
    expect(() => windowsSigning(env)).toThrow(message);
  });

  it("rejects Artifact Signing files that are missing, misnamed or incomplete", async () => {
    expect(() => windowsSigning({ LATCH_WIN_SIGN_DLIB: join(dir, "nope.dll"), LATCH_WIN_SIGN_METADATA: metadata })).toThrow("Azure.CodeSigning.Dlib.dll");
    expect(() => windowsSigning({ LATCH_WIN_SIGN_DLIB: "relative/Azure.CodeSigning.Dlib.dll", LATCH_WIN_SIGN_METADATA: metadata })).toThrow("absolute");
    await writeFile(metadata, JSON.stringify({ Endpoint: "https://x", CodeSigningAccountName: "acct" }));
    expect(() => windowsSigning({ LATCH_WIN_SIGN_DLIB: dlib, LATCH_WIN_SIGN_METADATA: metadata })).toThrow('"CertificateProfileName"');
    await writeFile(metadata, "{not json");
    expect(() => windowsSigning({ LATCH_WIN_SIGN_DLIB: dlib, LATCH_WIN_SIGN_METADATA: metadata })).toThrow("not valid JSON");
  });

  it("treats LATCH_WIN_SIGN_REQUIRED as a boolean", () => {
    expect(signingRequired({ LATCH_WIN_SIGN_REQUIRED: "1" })).toBe(true);
    expect(signingRequired({ LATCH_WIN_SIGN_REQUIRED: "true" })).toBe(true);
    expect(signingRequired({ LATCH_WIN_SIGN_REQUIRED: "0" })).toBe(false);
    expect(signingRequired({})).toBe(false);
  });
});

describe("sign commands", () => {
  it("sign with SHA-256 digests and an RFC 3161 timestamp", () => {
    const signing = windowsSigning({ LATCH_WIN_SIGN_THUMBPRINT: THUMB });
    if (signing.mode === "none") throw new Error("expected signing");
    expect(signArguments(signing)).toEqual(["sign", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", "/sha1", THUMB.toUpperCase()]);
  });

  it("build the Inno Setup sign tool with $q quoting and $f for the file", () => {
    const signing = windowsSigning({ LATCH_WIN_SIGN_DLIB: dlib, LATCH_WIN_SIGN_METADATA: metadata });
    if (signing.mode === "none") throw new Error("expected signing");
    const command = innoSignCommand("C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe", signing);
    expect(command).toBe(
      `$qC:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe$q sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $q${dlib}$q /dmdf $q${metadata}$q $f`,
    );
    expect(command).not.toContain('"');
    expect(() => innoSignCommand('C:\\evil" & calc', signing)).toThrow("quotes");
  });
});

describe("windows-installer prerequisites", () => {
  it("fail when signing is required but not configured", async () => {
    process.env.LATCH_WIN_SIGN_REQUIRED = "1";
    try {
      const checks = await TARGETS["windows-installer"].prerequisites();
      expect(checks.find((c) => c.name === "Code signing")).toMatchObject({ status: "fail", detail: expect.stringContaining("LATCH_WIN_SIGN_REQUIRED") });
    } finally {
      delete process.env.LATCH_WIN_SIGN_REQUIRED;
    }
  });

  it("warn that an unsigned installer is blocked when signing is optional", async () => {
    const checks = await TARGETS["windows-installer"].prerequisites();
    expect(checks.find((c) => c.name === "Code signing")).toMatchObject({ status: "skip", detail: expect.stringContaining("Smart App Control") });
  });

  it("render the installer script with the signing block", async () => {
    const iss = await readFile(new URL("../../packaging/windows/latchverify.iss.in", import.meta.url), "utf8");
    const block = iss.slice(iss.indexOf("#ifdef Sign"), iss.indexOf("#endif"));
    expect(block).toContain("SignTool=latchsign");
    expect(block).toContain("SignedUninstaller=yes");
  });
});
