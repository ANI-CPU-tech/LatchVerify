import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runSetup, runUnlink } from "../src/commands/setup.js";
import { runVerify } from "../src/commands/verify.js";
import { runWatch } from "../src/commands/watch.js";
import { clientConfigPath, type ClientId } from "../src/config/clients.js";
import { startProxy } from "../src/proxy/index.js";
import { CLIENT_HEADER, createRoutes } from "../src/ui/routes.js";

// "Read configs but never touch keys": a fake key, in the env and in the args of every server in
// every client config, must never come out of LatchVerify: not in a file it writes, not in its
// output, not in its API. The only places it may be are the client configs it was put in and the
// servers' own processes, which the client (here, the test) starts.

const CANARY = "sk-CANARY-7f3a91c4e2b8d605";
const tools = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/benign-tools.json", import.meta.url)), "utf8")).tools;

/** A stub server listing the benign tools. Its key arrives as `--token <key>` and in API_KEY. */
const server = () => ({
  command: process.execPath,
  args: [
    "-e",
    `const tools = ${JSON.stringify(tools)};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : m.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "ok" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
    // After "--", so node hands it to the script instead of reading it as its own option.
    "--",
    "--token",
    CANARY,
  ],
  env: { API_KEY: CANARY, MODE: "test" },
});

/** Every file under `dir`, recursively, as absolute paths. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe.skipIf(process.platform === "win32")("the canary key", { timeout: 60_000 }, () => {
  let home: string;
  let output = "";
  let configs: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-canary-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("LATCH_REVIEWER", "canary@example.com");
    output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += Buffer.from(chunk).toString("utf8");
      return true;
    });

    const write = async (client: ClientId, text: string) => {
      const path = clientConfigPath(client);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      return path;
    };
    const entry = JSON.stringify(server());
    configs = [
      await write("claude-code", JSON.stringify({ mcpServers: { cc: server() }, projects: { "/srv/app": { mcpServers: { project: server() } } } }, null, 2)),
      await write("cursor", JSON.stringify({ mcpServers: { cursor: server() } }, null, 2)),
      await write("vscode", `{\n  // mine\n  "servers": {\n    "vs": ${JSON.stringify({ type: "stdio", ...server() })},\n  },\n}\n`),
      await write("zed", `// Zed\n{\n  "context_servers": {\n    "zed": ${entry}\n  }\n}\n`),
    ];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  /** A Writable that adds what it gets to `output`. */
  const sink = () => {
    const stream = new PassThrough();
    stream.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    return stream;
  };

  it("never leaves LatchVerify, whatever runs", async () => {
    const lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    const stateDir = join(dirname(lockfilePath), ".latch");

    // Link everything, look at it every way, then unlink everything.
    expect(await runInit({ dryRun: true, lockfilePath, output: sink() })).toBe(0);
    expect(await runSetup({ client: undefined, dryRun: false, lockfilePath, output: sink() })).toBe(0);
    expect(await runWatch({ lockfilePath, stateDir, once: true, notify: false, logLevel: "debug", output: sink() })).toBe(0);

    // A client starting a wrapped server: the proxy gets the key in its args, as the client passes them.
    const wrapped = JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers.cursor as { command: string; args: string[] };
    const separator = wrapped.args.indexOf("--");
    const input = new PassThrough();
    const proxyOut = sink();
    const proxy = startProxy({
      serverId: "cursor",
      command: wrapped.args[separator + 1]!,
      args: wrapped.args.slice(separator + 2),
      lockfilePath,
      stateDir,
      input,
      output: proxyOut,
      logLevel: "debug",
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_alerts", arguments: { state: "CA" } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    input.end();
    await proxy;

    // verify's verdict does not matter here (servers that never ran have nothing pinned): what it prints does.
    await runVerify({ lockfilePath, json: false, configs, output: sink() });
    await runVerify({ lockfilePath, json: true, configs, output: sink() });

    const app = createRoutes({ lockfilePath, stateDir, reviewer: "canary@example.com" });
    for (const path of ["/api/info", "/api/lockfile", "/api/pending", "/api/events?limit=1000", "/api/lockfile/git", "/api/clients", "/api/settings"]) {
      output += await (await app.request(`http://127.0.0.1${path}`, { headers: { [CLIENT_HEADER]: "test" } })).text();
    }

    expect(await runUnlink({ client: undefined, dryRun: false, output: sink() })).toBe(0);

    // The first run happened: the proxy pinned the tools, so the whole path was exercised.
    expect(output).toContain("first run, so its tools were pinned");

    expect(output, "output").not.toContain(CANARY);
    const leaked: string[] = [];
    for (const file of [...(await filesUnder(home)), ...(await filesUnder(process.env.LATCH_INTEGRITY_DIR!))]) {
      if (configs.includes(file)) continue;
      if ((await readFile(file, "utf8")).includes(CANARY)) leaked.push(relative(home, file));
    }
    expect(leaked, "files holding the key").toEqual([]);

    // And the client configs still hold it exactly where the user put it.
    for (const config of configs) expect(await readFile(config, "utf8")).toContain(CANARY);
  });
});
