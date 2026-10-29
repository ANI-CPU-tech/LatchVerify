import { launchHash, programName } from "../../src/analyze/hash.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFY_EXIT, VERIFY_REPORT_VERSION, runVerify, type VerifyReport } from "../../src/commands/verify.js";
import { LockFileSchema, type LockFile, type ServerEntry } from "../../src/schema/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const example = (): LockFile => LockFileSchema.parse(JSON.parse(readFileSync(join(root, "latch.lock.example"), "utf8")));
const benignTools = JSON.parse(readFileSync(join(root, "tests/fixtures/benign-tools.json"), "utf8")).tools as Array<Record<string, unknown>>;

/** How a server is started: what an MCP config holds, and latch.lock only as a hash. */
type Launch = { command: string; args: string[] };

/** A stub server that answers initialize and lists `tools`. */
const listing = (tools: unknown[]): Launch => ({
  command: process.execPath,
  args: [
    "-e",
    `const tools = ${JSON.stringify(tools)};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
  ],
});

const demo = (script: string): Launch => ({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "demo", script)],
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-verify-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const pinnedFor = (launch: Launch) => ({ program: programName(launch.command), launch: launchHash(launch.command, launch.args) });

/**
 * latch.lock.example with the weather server pinned for `weather`'s launch, plus `extra` stdio
 * servers (no tools) and `other` entries as given. The launch lines go into mcp.json beside it,
 * which verify() passes as --config, since latch.lock keeps only their hash.
 */
async function lockfile(weather: Launch, extra: Record<string, Launch> = {}, other: Record<string, ServerEntry> = {}): Promise<string> {
  const lock = example();
  Object.assign(lock.servers.weather!, pinnedFor(weather));
  for (const [id, launch] of Object.entries(extra)) lock.servers[id] = { transport: "stdio", ...pinnedFor(launch), tools: [] };
  Object.assign(lock.servers, other);
  const path = join(dir, "latch.lock");
  await writeFile(path, JSON.stringify(lock));
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { weather, ...extra } }));
  return path;
}

/** Run verify and return its exit code and text, without ANSI colours. */
async function verify(lockfilePath: string, json = false) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await runVerify({ lockfilePath, json, output, timeoutMs: 20_000, configs: [join(dir, "mcp.json")] });
  return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
}

/** Run verify --json and return its exit code and parsed report. */
async function verifyJson(lockfilePath: string): Promise<{ code: number; report: VerifyReport; text: string }> {
  const { code, text } = await verify(lockfilePath, true);
  return { code, report: JSON.parse(text) as VerifyReport, text };
}

describe("runVerify", () => {
  it("exits 0 against the benign weather server", async () => {
    const { code, text } = await verify(await lockfile(demo("weather-server.ts")));
    expect(code).toBe(VERIFY_EXIT.ok);
    expect(text).toContain("latch verify: 1 server in");
    expect(text).toMatch(/✔ get_alerts\s+unchanged/);
    expect(text).toMatch(/✔ get_forecast\s+unchanged/);
    expect(text.trimEnd().endsWith("✔ ok (exit 0): every server matches latch.lock")).toBe(true);
  });

  it("exits 2 against the mutated evil server, printing the tier-3 reasons", async () => {
    vi.stubEnv("DEMO_MUTATE", "1");
    const { code, text } = await verify(await lockfile(demo("evil-server.ts")));
    expect(code).toBe(VERIFY_EXIT.hardBlock);
    expect(text).toMatch(/✖ get_forecast\s+tier 3 {2}Critical pattern finding/);
    expect(text).toContain('Text points the model at a sensitive file (description): "~/.ssh/id_rsa"');
    expect(text).toMatch(/✖ read_config\s+new, tier 2 {2}Gained filesystem\.read/);
    expect(text).toMatch(/✖ run_diagnostics\s+new, tier 3/);
    expect(text).toMatch(/- get_alerts\s+removed from the server/);
    expect(text).toContain("✖ hard block (exit 2)");
  });

  it("exits 3 when a server cannot be started", async () => {
    const { code, text } = await verify(await lockfile({ command: "latch-no-such-binary-for-test", args: [] }));
    expect(code).toBe(VERIFY_EXIT.error);
    expect(text).toContain("✖ could not verify: could not start latch-no-such-binary-for-test");
    expect(text).toContain("✖ error (exit 3)");
  });

  it("exits 1 for a tool that is listed but not pinned, even at tier 0", async () => {
    const extra = { name: "harmless", description: "Says hello.", inputSchema: { type: "object" } };
    const { code, text } = await verify(await lockfile(listing([...benignTools, extra])));
    expect(code).toBe(VERIFY_EXIT.drift);
    expect(text).toMatch(/✖ harmless\s+new, tier 0/);
  });

  it("exits 1 for a tier-2 change to a pinned tool", async () => {
    const [forecast, alerts] = benignTools;
    const loosened = {
      ...forecast,
      inputSchema: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, url: { type: "string" } } },
    };
    const { code, text } = await verify(await lockfile(listing([loosened, alerts])));
    expect(code).toBe(VERIFY_EXIT.drift);
    expect(text).toMatch(/✖ get_forecast\s+tier 2/);
  });

  it("exits 0 for a tier-0 change and for a removed tool, but reports both", async () => {
    const [forecast] = benignTools;
    const { code, text } = await verify(await lockfile(listing([{ ...forecast, description: "Fetch the forecast for a location." }])));
    expect(code).toBe(VERIFY_EXIT.ok);
    expect(text).toMatch(/~ get_forecast\s+tier 0 {2}Text changed \(description\); capabilities unchanged/);
    expect(text).toMatch(/- get_alerts\s+removed from the server/);
  });

  it("checks every server and exits with the worst outcome", async () => {
    const broken: Launch = { command: "latch-no-such-binary-for-test", args: [] };
    vi.stubEnv("DEMO_MUTATE", "1");
    const { code, text } = await verify(await lockfile(demo("evil-server.ts"), { broken }));
    expect(code).toBe(VERIFY_EXIT.error);
    expect(text.indexOf("broken")).toBeLessThan(text.indexOf("weather"));
    expect(text).toContain("✖ get_forecast");
  });

  it("reports a server with an unsupported transport as an error", async () => {
    const remote: ServerEntry = { transport: "http", program: "https://mcp.example", launch: "a".repeat(64), tools: [] };
    const { code, text } = await verify(await lockfile(demo("weather-server.ts"), {}, { remote }));
    expect(code).toBe(VERIFY_EXIT.error);
    expect(text).toContain('could not verify: transport "http" is not supported');
  });

  it("exits 3 for a missing or invalid lockfile, never passing vacuously", async () => {
    const missing = join(dir, "nope.lock");
    expect(await verify(missing)).toEqual({ code: 3, text: `✖ no lockfile at ${missing}; run \`latch init\` to create one\n✖ error (exit 3)\n` });
    const invalid = join(dir, "bad.lock");
    await writeFile(invalid, "{ nope");
    expect((await verify(invalid)).code).toBe(VERIFY_EXIT.error);
  });

  it("exits 0 for a lockfile with no servers", async () => {
    const path = join(dir, "empty.lock");
    await writeFile(path, JSON.stringify({ version: "1", generatedAt: "2026-10-23T09:00:00.000Z", servers: {} }));
    await writeFile(join(dir, "mcp.json"), "{}");
    const { code, text } = await verify(path);
    expect(code).toBe(VERIFY_EXIT.ok);
    expect(text).toContain("latch verify: 0 servers in");
  });

  it("takes each launch from the config, only when it is the launch latch.lock pinned", async () => {
    const path = await lockfile(demo("weather-server.ts"));
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { weather: demo("evil-server.ts") } }));
    const changed = await verifyJson(path);
    expect(changed.code).toBe(VERIFY_EXIT.error);
    expect(changed.report.servers[0]!.error).toBe(`${join(dir, "mcp.json")} starts it differently than latch.lock pinned it; review the change with \`latch init\` or fix the config`);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect((await verifyJson(path)).report.servers[0]!.error).toMatch(/^no launch line for it: latch\.lock keeps only a hash of it/);
  });

  it("never shows a server's arguments, which may hold a key", async () => {
    const keyed = { command: process.execPath, args: [...demo("weather-server.ts").args, "--token", "sk-CANARY-verify"] };
    const { text } = await verify(await lockfile(keyed));
    expect(text).not.toContain("sk-CANARY-verify");
    expect((await verify(await lockfile(keyed), true)).text).not.toContain("sk-CANARY-verify");
  });

  it("never prints a server's control characters to the terminal", async () => {
    const hostile = { name: "evil\u001b[2J\u202etool", description: "x", inputSchema: { type: "object" } };
    const { text } = await verify(await lockfile(listing([...benignTools, hostile])));
    expect(text).not.toMatch(/[\u001b\u202e]/);
    expect(text).toContain("evil[U+001B][2J[U+202E]tool");
  });
});

describe("runVerify --json", () => {
  it("reports a clean run as one JSON document", async () => {
    const path = await lockfile(demo("weather-server.ts"));
    const { code, report, text } = await verifyJson(path);
    expect(code).toBe(0);
    expect(text.endsWith("}\n")).toBe(true);
    expect(report).toEqual({
      version: VERIFY_REPORT_VERSION,
      lockfile: path,
      status: "ok",
      exitCode: 0,
      servers: [
        {
          serverId: "weather",
          program: programName(process.execPath),
          status: "ok",
          specVersion: "2025-06-18",
          tools: [
            { name: "get_alerts", status: "unchanged" },
            { name: "get_forecast", status: "unchanged" },
          ],
        },
      ],
    });
  });

  it("carries tiers, reasons, deltas and findings for a hard block", async () => {
    vi.stubEnv("DEMO_MUTATE", "1");
    const { code, report } = await verifyJson(await lockfile(demo("evil-server.ts")));
    expect(code).toBe(2);
    expect(report.status).toBe("hard_block");
    expect(report.exitCode).toBe(2);
    const tools = report.servers[0]!.tools;
    expect(tools.map((t) => [t.name, t.status, t.tier])).toEqual([
      ["get_forecast", "changed", 3],
      ["read_config", "new", 2],
      ["run_diagnostics", "new", 3],
      ["sync_alerts", "new", 3],
      ["get_alerts", "removed", undefined],
    ]);
    const forecast = tools[0]!;
    expect(forecast.reason).toMatch(/^Critical pattern finding/);
    expect(forecast.capabilityDelta).toEqual({ gained: [], lost: [], loosened: [] });
    expect(forecast.findings!.some((f) => f.severity === "critical" && f.evidence.includes("~/.ssh/id_rsa"))).toBe(true);
  });

  it("reports a server error and a lockfile error in JSON too", async () => {
    const broken = await verifyJson(await lockfile({ command: "latch-no-such-binary-for-test", args: [] }));
    expect(broken.code).toBe(3);
    expect(broken.report.servers[0]).toMatchObject({ status: "error", error: expect.stringMatching(/^could not start /), tools: [] });

    const missing = join(dir, "missing.lock");
    expect((await verifyJson(missing)).report).toEqual({
      version: VERIFY_REPORT_VERSION,
      lockfile: missing,
      status: "error",
      exitCode: 3,
      error: `no lockfile at ${missing}; run \`latch init\` to create one`,
      servers: [],
    });
  });

  it("keeps a server's strings verbatim, escaped only by JSON", async () => {
    const hostile = { name: "evil\u001b[2Jtool", description: "x", inputSchema: { type: "object" } };
    const { report, text } = await verifyJson(await lockfile(listing([...benignTools, hostile])));
    expect(text).not.toContain("\u001b");
    expect(report.servers[0]!.tools[0]!.name).toBe("evil\u001b[2Jtool");
  });
});

describe("latch verify (CLI)", () => {
  it("exits 3, not the drift code, when the command fails unexpectedly", () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const result = spawnSync(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), "verify"], {
      cwd: root,
      env: { ...process.env, LATCH_UI_PORT: "not-a-port" },
      encoding: "utf8",
    });
    expect(result.stderr).toContain("LATCH_UI_PORT must be a port number");
    expect(result.status).toBe(VERIFY_EXIT.error);
  });
});
