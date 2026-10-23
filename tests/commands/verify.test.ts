import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFY_EXIT, printable, runVerify } from "../../src/commands/verify.js";
import { LockFileSchema, type LockFile, type ServerEntry } from "../../src/schema/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const example = (): LockFile => LockFileSchema.parse(JSON.parse(readFileSync(join(root, "latch.lock.example"), "utf8")));
const benignTools = JSON.parse(readFileSync(join(root, "tests/fixtures/benign-tools.json"), "utf8")).tools as Array<Record<string, unknown>>;

/** A stub server that answers initialize and lists `tools`. */
const listing = (tools: unknown[]): Pick<ServerEntry, "command" | "args"> => ({
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

const demo = (script: string): Pick<ServerEntry, "command" | "args"> => ({
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

/** latch.lock.example with the weather server launched as `weather`, plus any `extra` servers. */
async function lockfile(weather: Pick<ServerEntry, "command" | "args">, extra: Record<string, ServerEntry> = {}): Promise<string> {
  const lock = example();
  Object.assign(lock.servers.weather!, weather);
  Object.assign(lock.servers, extra);
  const path = join(dir, "latch.lock");
  await writeFile(path, JSON.stringify(lock));
  return path;
}

/** Run verify and return its exit code and text, without ANSI colours. */
async function verify(lockfilePath: string) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await runVerify({ lockfilePath, json: false, output, timeoutMs: 20_000 });
  return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
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

  it("exits 0 for a tier-1 change and for a removed tool, but reports both", async () => {
    const [forecast] = benignTools;
    const { code, text } = await verify(await lockfile(listing([{ ...forecast, description: "Fetch the forecast for a location." }])));
    expect(code).toBe(VERIFY_EXIT.ok);
    expect(text).toMatch(/~ get_forecast\s+tier 1 {2}Narrowed: network\.domains:api\.weather\.gov/);
    expect(text).toMatch(/- get_alerts\s+removed from the server/);
  });

  it("checks every server and exits with the worst outcome", async () => {
    const broken: ServerEntry = { transport: "stdio", command: "latch-no-such-binary-for-test", args: [], tools: [] };
    vi.stubEnv("DEMO_MUTATE", "1");
    const { code, text } = await verify(await lockfile(demo("evil-server.ts"), { broken }));
    expect(code).toBe(VERIFY_EXIT.error);
    expect(text.indexOf("broken")).toBeLessThan(text.indexOf("weather"));
    expect(text).toContain("✖ get_forecast");
  });

  it("reports a server with an unsupported transport as an error", async () => {
    const remote: ServerEntry = { transport: "http", command: "https://mcp.example", args: [], tools: [] };
    const { code, text } = await verify(await lockfile(demo("weather-server.ts"), { remote }));
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
    const { code, text } = await verify(path);
    expect(code).toBe(VERIFY_EXIT.ok);
    expect(text).toContain("latch verify: 0 servers in");
  });

  it("never prints a server's control characters to the terminal", async () => {
    const hostile = { name: "evil\u001b[2J‮tool", description: "x", inputSchema: { type: "object" } };
    const { text } = await verify(await lockfile(listing([...benignTools, hostile])));
    expect(text).not.toMatch(/[\u001b‮]/);
    expect(text).toContain("evil[U+001B][2J[U+202E]tool");
  });
});

describe("printable", () => {
  it("escapes control and format characters but keeps other Unicode", () => {
    expect(printable("café 😀 ok")).toBe("café 😀 ok");
    expect(printable("a\u0000b\nc​d e\u{e0068}")).toBe("a[U+0000]b[U+000A]c[U+200B]d[U+2028]e[U+E0068]");
  });
});
