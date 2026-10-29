import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientConfigPath } from "../../src/config/clients.js";
import { ClientsReportSchema, DEFAULT_SETTINGS, SettingsSchema } from "../../src/schema/index.js";
import { emptyLockfile, writeLockfile } from "../../src/store/lockfile.js";
import { CLIENT_HEADER, createRoutes, type RouteDeps } from "../../src/ui/routes.js";

const tools = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/benign-tools.json", import.meta.url)), "utf8")).tools;
const SECRET = "sk-CANARY-routes";
/** A stdio server with a key in its args and its env. */
const server = { command: process.execPath, args: ["-e", `/* ${tools.length} */`, "--", "--token", SECRET], env: { API_KEY: SECRET } };

describe.skipIf(process.platform === "win32")("the clients and settings API", () => {
  let home: string;
  let deps: RouteDeps;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-clients-api-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
    deps = { lockfilePath, stateDir: join(dirname(lockfilePath), ".latch"), reviewer: "api@example.com", settingsPath: join(dirname(lockfilePath), "settings.json") };
    const cursor = clientConfigPath("cursor");
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(cursor, JSON.stringify({ mcpServers: { weather: server, remote: { type: "http", url: "https://mcp.example" } } }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  const call = async (path: string, init: RequestInit = {}) => createRoutes(deps).request(`http://127.0.0.1${path}`, init);
  const post = (path: string) => call(path, { method: "POST", headers: { [CLIENT_HEADER]: "test" } });

  it("lists the clients found, per client, with programs and states but no argument or env value", async () => {
    const response = await call("/api/clients");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(ClientsReportSchema.parse(JSON.parse(text))).toEqual({
      clients: [
        {
          id: "cursor",
          name: "Cursor",
          answer: "unasked",
          files: [{ path: clientConfigPath("cursor") }],
          servers: [{ id: "weather", program: "node", linked: false, pin: "absent", tools: 0 }],
          problems: [],
        },
      ],
    });
  });

  it("connects a client: records the yes and links it at once, to be pinned on first run", async () => {
    const response = await post("/api/clients/cursor/connect");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).clients[0]).toMatchObject({ answer: "connected", servers: [{ id: "weather", linked: true, pin: "first_run" }] });
    expect(JSON.parse(await readFile(deps.settingsPath!, "utf8")).clients).toEqual({ cursor: true });
    const config = JSON.parse(await readFile(clientConfigPath("cursor"), "utf8"));
    expect(config.mcpServers.weather.args).toContain("proxy");
    expect(config.mcpServers.weather.env).toEqual({ API_KEY: SECRET });
    expect(await readFile(deps.lockfilePath, "utf8")).not.toContain(SECRET);
  });

  it("disconnects a client: original commands back, the no recorded", async () => {
    await post("/api/clients/cursor/connect");
    const response = await post("/api/clients/cursor/disconnect");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { clients: unknown[] }).clients[0]).toMatchObject({ answer: "declined", servers: [{ linked: false }] });
    expect(JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers.weather).toEqual(server);
  });

  it("guards the writes and refuses an unknown client", async () => {
    expect((await call("/api/clients/cursor/connect", { method: "POST" })).status).toBe(403);
    expect((await post("/api/clients/notepad/connect")).status).toBe(404);
    expect((await post("/api/clients/notepad/disconnect")).status).toBe(404);
  });

  it("reads and changes the settings, refusing anything that is not a setting", async () => {
    expect(SettingsSchema.parse(await (await call("/api/settings")).json())).toEqual(DEFAULT_SETTINGS);
    const put = (body: string, headers: Record<string, string> = { [CLIENT_HEADER]: "test", "content-type": "application/json" }) => call("/api/settings", { method: "PUT", headers, body });
    const changed = await put(JSON.stringify({ notifications: false, clients: { zed: false } }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ...DEFAULT_SETTINGS, notifications: false, clients: { zed: false } });
    expect((await put(JSON.stringify({ theme: "dark" }))).status).toBe(400);
    expect((await put("{ nope")).status).toBe(400);
    expect((await put("{}", {})).status).toBe(403);
    expect((await put(JSON.stringify({ lastUpdateCheck: "x".repeat(20_000) }))).status).toBe(413);
  });
});

describe.skipIf(process.platform === "win32")("the dev preset API", () => {
  let home: string;
  let deps: RouteDeps;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-dev-api-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
    deps = { lockfilePath, stateDir: join(dirname(lockfilePath), ".latch"), reviewer: "api@example.com", settingsPath: join(dirname(lockfilePath), "settings.json") };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  const request = (dev: boolean, path: string, body?: unknown) =>
    createRoutes({ ...deps, dev }).request(`http://127.0.0.1${path}`, body === undefined ? {} : { method: "POST", headers: { [CLIENT_HEADER]: "test", "content-type": "application/json" }, body: JSON.stringify(body) });

  it("does not exist outside development mode", async () => {
    expect((await request(false, "/api/dev/presets")).status).toBe(404);
    expect((await request(false, "/api/dev/presets/demo-weather/add", { client: "cursor" })).status).toBe(404);
  });

  it("lists, adds and removes presets in development mode", async () => {
    const list = await (await request(true, "/api/dev/presets")).json();
    expect(list).toMatchObject({ available: true, presets: expect.arrayContaining([expect.objectContaining({ id: "demo-weather", clients: [], inLockfile: false })]) });
    const added = await request(true, "/api/dev/presets/demo-weather/add", { client: "cursor" });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { output: string }).output).toContain("✔ demo-weather: linked");
    expect(JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers["demo-weather"].args).toContain("proxy");
    expect((await request(true, "/api/dev/presets/demo-weather/add", { client: "cursor" })).status).toBe(409);
    expect(await (await request(true, "/api/dev/presets/demo-weather/remove", { client: "cursor" })).json()).toEqual({ clients: ["cursor"], lockfile: true });
    expect((await request(true, "/api/dev/presets/nope/add", { client: "cursor" })).status).toBe(404);
    expect((await request(true, "/api/dev/presets/demo-weather/add", { client: "notepad" })).status).toBe(400);
  });
});
