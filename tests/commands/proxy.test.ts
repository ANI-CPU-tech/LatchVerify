import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProxy } from "../../src/commands/proxy.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Absolute, so children started outside the repo still find tsx.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cli = join(root, "src/cli.ts");
const weather = [process.execPath, "--import", tsx, join(root, "demo/weather-server.ts")];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-proxy-cmd-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (message: unknown) => `${JSON.stringify(message)}\n`;
const request = (id: number, method: string, params?: unknown) =>
  line(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });

/**
 * Run `latch <cliArgs>` as a real process with `lines` on stdin, then close stdin once every
 * expected response id has arrived (or straight away when none is expected).
 */
async function latch(cliArgs: string[], lines: string[], expectIds: number[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, ["--import", tsx, cli, ...cliArgs], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = once(child, "close") as Promise<[number | null]>;
  for (const l of lines) child.stdin.write(l);
  const deadline = Date.now() + 20_000;
  const seen = () => stdout.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id?: unknown }).id);
  while (expectIds.some((id) => !seen().includes(id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  const [code] = await closed;
  return { code, stdout, stderr };
}

describe("runProxy", () => {
  const base = { serverId: "weather", command: weather, lockfilePath: "latch.lock.example", stateDir: ".latch" };

  it("refuses an empty server id", async () => {
    await expect(runProxy({ ...base, serverId: "" })).rejects.toThrow("latch proxy: --server needs the server's id in latch.lock");
  });

  it("refuses a missing or empty command", async () => {
    for (const command of [[], [""]]) {
      await expect(runProxy({ ...base, command }), JSON.stringify(command)).rejects.toThrow(
        "latch proxy: give the real server command after --",
      );
    }
  });
});

describe("latch proxy (CLI)", () => {
  const proxyArgs = (stateDir: string, lockfile = join(root, "latch.lock.example")) => [
    "--lockfile",
    lockfile,
    "--state-dir",
    stateDir,
    "proxy",
    "--server",
    "weather",
    "--",
    ...weather,
  ];

  it("works as an MCP server and writes nothing but JSON-RPC to stdout (task Verify)", async () => {
    const { code, stdout, stderr } = await latch(
      proxyArgs(dir),
      [
        request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
        line({ jsonrpc: "2.0", method: "notifications/initialized" }),
        request(2, "tools/list"),
        request(3, "tools/call", { name: "get_alerts", arguments: { state: "CA" } }),
        request(4, "tools/call", { name: "read_config", arguments: { path: "/etc/passwd" } }),
      ],
      [1, 2, 3, 4],
    );
    expect(code).toBe(0);
    const messages = stdout.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(messages.every((m) => m.jsonrpc === "2.0")).toBe(true);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId[1]).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    expect((byId[2] as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toEqual(["get_forecast", "get_alerts"]);
    expect(byId[3]).toMatchObject({ result: { content: [{ text: "No active weather alerts for CA." }] } });
    expect(byId[4]).toMatchObject({ error: { code: -32001, data: { reason: { kind: "unpinned" } } } });
    expect(stderr).toContain("[latch] blocked weather/read_config: unpinned");
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain('"call_blocked"');
  }, 30_000);

  it("resolves relative paths against the working directory", async () => {
    await writeFile(join(dir, "latch.lock"), await readFile(join(root, "latch.lock.example"), "utf8"));
    const { code } = await latch(
      ["--lockfile", "latch.lock", "--state-dir", "state", "proxy", "--server", "weather", "--", ...weather],
      [request(1, "tools/list"), request(2, "tools/call", { name: "nope", arguments: {} })],
      [1, 2],
      { cwd: dir },
    );
    expect(code).toBe(0);
    expect(await readFile(join(dir, "state", "events.jsonl"), "utf8")).toContain('"toolName":"nope"');
  }, 30_000);

  it("exits with the real server's exit code", async () => {
    const { code, stdout } = await latch(
      ["--lockfile", join(root, "latch.lock.example"), "--state-dir", dir, "proxy", "--server", "weather", "--", process.execPath, "-e", "process.exit(7)"],
      [],
    );
    expect(code).toBe(7);
    expect(stdout).toBe("");
  }, 30_000);

  it("fails on stderr only when the server cannot start or the lockfile is malformed", async () => {
    const missing = await latch(
      ["--lockfile", join(root, "latch.lock.example"), "--state-dir", dir, "proxy", "--server", "weather", "--", "latch-no-such-binary-for-test"],
      [],
    );
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("could not start latch-no-such-binary-for-test");

    const bad = join(dir, "bad.lock");
    await writeFile(bad, "{ nope");
    const malformed = await latch(proxyArgs(dir, bad), []);
    expect(malformed.code).toBe(1);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain(bad);
  }, 30_000);
});

describe("latch proxy paths from the environment", () => {
  const lines = [request(1, "tools/list"), request(2, "tools/call", { name: "get_alerts", arguments: { state: "CA" } })];
  const blockedId2 = (stdout: string) => stdout.includes('"id":2,"error"');

  it("uses LATCH_LOCKFILE_PATH and LATCH_STATE_DIR when the flags are not given", async () => {
    const state = join(dir, "state");
    const { code, stdout } = await latch(["proxy", "--server", "weather", "--", ...weather], lines, [1, 2], {
      cwd: dir,
      env: { LATCH_LOCKFILE_PATH: ` ${join(root, "latch.lock.example")} `, LATCH_STATE_DIR: state },
    });
    expect(code).toBe(0);
    expect(blockedId2(stdout)).toBe(false);
    expect(await readFile(join(state, "events.jsonl"), "utf8")).toContain('"tools_listed"');
  }, 30_000);

  it("lets explicit flags win over the environment", async () => {
    const { stdout } = await latch(
      ["--lockfile", join(root, "latch.lock.example"), "--state-dir", dir, "proxy", "--server", "weather", "--", ...weather],
      lines,
      [1, 2],
      { cwd: dir, env: { LATCH_LOCKFILE_PATH: join(dir, "missing.lock"), LATCH_STATE_DIR: join(dir, "elsewhere") } },
    );
    expect(blockedId2(stdout)).toBe(false);
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain('"tools_listed"');
  }, 30_000);

  it("reads the paths from ./.env, and refuses a malformed environment", async () => {
    const state = join(dir, "from-dotenv");
    await writeFile(join(dir, ".env"), `LATCH_LOCKFILE_PATH=${join(root, "latch.lock.example")}\nLATCH_STATE_DIR=${state}\n`);
    const { code, stdout } = await latch(["proxy", "--server", "weather", "--", ...weather], lines, [1, 2], { cwd: dir });
    expect(code).toBe(0);
    expect(blockedId2(stdout)).toBe(false);
    expect(await readFile(join(state, "events.jsonl"), "utf8")).toContain('"tools_listed"');

    await writeFile(join(dir, ".env"), "LATCH_LLM_ENABLED=true\n");
    const bad = await latch(["proxy", "--server", "weather", "--", ...weather], [], [], { cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("LATCH_LLM_ENABLED is true but LATCH_LLM_API_KEY is not set");
  }, 30_000);

  it("keeps state next to the lockfile when no state directory is given", async () => {
    await mkdir(join(dir, "repo"));
    await writeFile(join(dir, "repo", "latch.lock"), await readFile(join(root, "latch.lock.example"), "utf8"));
    const { code } = await latch(["--lockfile", "repo/latch.lock", "proxy", "--server", "weather", "--", ...weather], lines, [1, 2], {
      cwd: dir,
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, "repo", ".latch", "events.jsonl"), "utf8")).toContain('"tools_listed"');
  }, 30_000);

  it("falls back to ./latch.lock when the variables are blank", async () => {
    const { stdout } = await latch(["proxy", "--server", "weather", "--", ...weather], lines, [1, 2], {
      cwd: dir,
      env: { LATCH_LOCKFILE_PATH: "  ", LATCH_STATE_DIR: "" },
    });
    // No latch.lock in the working directory: the server is unpinned, so the call is blocked.
    expect(blockedId2(stdout)).toBe(true);
    expect(await readFile(join(dir, ".latch", "events.jsonl"), "utf8")).toContain('"toolName":"get_alerts","reason":"server_unpinned"');
  }, 30_000);
});
