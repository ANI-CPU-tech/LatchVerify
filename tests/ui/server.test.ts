import { request as httpRequest } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_HOST, defaultReviewer, startUiServer, type UiServerHandle, type UiServerOptions } from "../../src/ui/server.js";
import { CLIENT_HEADER } from "../../src/ui/routes.js";
import { findRecord, readLockfile } from "../../src/store/lockfile.js";
import { writePending } from "../../src/store/pending.js";
import type { PendingChange } from "../../src/schema/index.js";

const EXAMPLE_LOCK = new URL("../../latch.lock.example", import.meta.url);

let dir: string;
let options: UiServerOptions;
const handles: UiServerHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-server-"));
  options = { port: 0, lockfilePath: join(dir, "latch.lock"), stateDir: join(dir, ".latch"), reviewer: "alice@example.com" };
  await copyFile(EXAMPLE_LOCK, options.lockfilePath);
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

const start = async (overrides: Partial<UiServerOptions> = {}): Promise<UiServerHandle> => {
  const handle = await startUiServer({ ...options, ...overrides });
  handles.push(handle);
  return handle;
};

/** Raw HTTP GET with full control of the Host header, which fetch() does not allow. */
const rawGet = (url: string, host: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

describe("startUiServer", () => {
  it("serves the API on 127.0.0.1 with the port it bound", async () => {
    const handle = await start();
    expect(handle.url).toMatch(new RegExp(`^http://${UI_HOST.replaceAll(".", "\\.")}:\\d+$`));
    const response = await fetch(`${handle.url}/api/pending`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("is not reachable on other interfaces", async () => {
    const handle = await start();
    const port = new URL(handle.url).port;
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) return; // no non-loopback interface on this machine
    await expect(fetch(`http://${external.address}:${port}/api/pending`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
  });

  it("refuses requests whose Host header is not loopback (DNS rebinding)", async () => {
    const handle = await start();
    const port = new URL(handle.url).port;
    expect((await rawGet(`${handle.url}/api/pending`, `evil.example:${port}`)).status).toBe(403);
    expect((await rawGet(`${handle.url}/api/pending`, `localhost:${port}`)).status).toBe(200);
  });

  it("approves a change end to end over HTTP", async () => {
    const lock = await readLockfile(options.lockfilePath);
    const before = lock.servers.weather!.tools.find((t) => t.name === "get_forecast")!;
    const change: PendingChange = {
      id: "chg_http",
      serverId: "weather",
      toolName: "get_forecast",
      tier: 3,
      detectedAt: "2026-10-23T09:00:00.000Z",
      before,
      after: { ...before, hashes: { ...before.hashes, composite: "e".repeat(64) } },
      capabilityDelta: { gained: [], lost: [], loosened: [] },
      findings: [],
    };
    await writePending(options.stateDir, [change]);
    const handle = await start();

    const refused = await fetch(`${handle.url}/api/pending/chg_http/approve`, { method: "POST" });
    expect(refused.status).toBe(403);
    const approved = await fetch(`${handle.url}/api/pending/chg_http/approve`, { method: "POST", headers: { [CLIENT_HEADER]: "review-ui" } });
    expect(approved.status).toBe(200);
    expect(findRecord(await readLockfile(options.lockfilePath), "weather", "get_forecast")?.hashes.composite).toBe("e".repeat(64));
    expect(await (await fetch(`${handle.url}/api/pending`)).json()).toEqual([]);
  });

  it("rejects a port that is already in use", async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    await expect(start({ port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("rejects an invalid port before binding anything", async () => {
    for (const port of [-1, 65_536, 1.5, Number.NaN]) await expect(start({ port })).rejects.toThrow(RangeError);
  });

  it("closes, even with keep-alive connections, and close can be called twice", async () => {
    const handle = await start();
    await fetch(`${handle.url}/api/pending`, { headers: { connection: "keep-alive" } });
    await handle.close();
    await handle.close();
    await expect(fetch(`${handle.url}/api/pending`)).rejects.toThrow();
  });
});

describe("startUiServer with a built UI", () => {
  let staticDir: string;
  beforeEach(async () => {
    staticDir = join(dir, "web");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>LatchVerify</title>");
    await writeFile(join(staticDir, "assets", "app.js"), "console.log('app');");
    await writeFile(join(dir, "secret.txt"), "do not serve");
  });

  it("serves index.html at / and the built assets", async () => {
    const handle = await start({ staticDir });
    expect(await (await fetch(`${handle.url}/`)).text()).toContain("<title>LatchVerify</title>");
    const asset = await fetch(`${handle.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('app');");
  });

  it("answers client-side routes with index.html but unknown API routes with a JSON 404", async () => {
    const handle = await start({ staticDir });
    expect(await (await fetch(`${handle.url}/changes/chg_1`)).text()).toContain("<title>LatchVerify</title>");
    const api = await fetch(`${handle.url}/api/nope`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "no route for GET /api/nope" });
  });

  it("never serves files outside the UI directory", async () => {
    const handle = await start({ staticDir });
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/..%5csecret.txt"]) {
      const { body } = await rawGet(`${handle.url}${path}`, new URL(handle.url).host);
      expect(body).not.toContain("do not serve");
    }
  });

  it("refuses to start when the UI has not been built", async () => {
    await expect(start({ staticDir: join(dir, "missing") })).rejects.toThrow(/has no index\.html/);
  });
});

describe("defaultReviewer", () => {
  it("prefers LATCH_REVIEWER, trimmed", () => {
    expect(defaultReviewer({ LATCH_REVIEWER: "  carol@example.com " })).toBe("carol@example.com");
  });

  it("falls back to git or the OS user when LATCH_REVIEWER is unset or blank", () => {
    for (const env of [{}, { LATCH_REVIEWER: "   " }]) expect(defaultReviewer(env).length).toBeGreaterThan(0);
  });
});
