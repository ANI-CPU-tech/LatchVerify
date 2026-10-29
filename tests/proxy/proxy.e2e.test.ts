import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startProxy, type ProxyOptions } from "../../src/proxy/index.js";
import { readEvents } from "../../src/store/events.js";
import { applyApproval, readLockfile, serializeLockfile, writeLockfile } from "../../src/store/lockfile.js";
import { runLockAccept } from "../../src/commands/lock.js";
import { dequeue, readPending, writePending } from "../../src/store/pending.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lockfilePath = join(root, "latch.lock.example");
const benignTools = JSON.parse(readFileSync(join(root, "tests/fixtures/benign-tools.json"), "utf8")).tools as unknown[];

/** A stub server: lists `tools` and echoes every other request's raw line back. */
const echoServer = (tools: unknown[]) => `
const tools = ${JSON.stringify(tools)};
process.stdout.write('{ "jsonrpc" : "2.0", "method":"notifications/custom", "x-vendor":{"a":[1, 2.50]} }\\n');
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "tools/list" ? { tools } : { raw: line };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`;

let stateDir: string;
let stderr: string[];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "latch-e2e-"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(stateDir, { recursive: true, force: true });
});

const line = (message: unknown) => JSON.stringify(message);
const request = (id: number, method: string, params?: unknown) =>
  line(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
const alerts = (id: number) => request(id, "tools/call", { name: "get_alerts", arguments: { state: "CA" } });

async function waitFor(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Run startProxy in-process over in-memory client streams. `steps` are lines to send, or
 * functions that wait on the output so far. Input is closed after the last step.
 */
async function run(
  server: { args: string[]; command?: string },
  steps: Array<string | ((output: () => string) => Promise<void>)>,
  options: Partial<ProxyOptions> = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const done = startProxy({
    serverId: "weather",
    command: server.command ?? process.execPath,
    args: server.args,
    lockfilePath,
    stateDir,
    input,
    output,
    ...options,
  });
  for (const step of steps) {
    if (typeof step === "string") input.write(`${step}\n`);
    else await step(() => text);
  }
  input.end();
  const code = await done;
  const messages = text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, text, messages };
}

const evil = { args: ["--import", "tsx", join(root, "demo/evil-server.ts")] };
const echo = { args: ["-e", echoServer(benignTools)] };

describe("startProxy", () => {
  it("blocks the rug-pulled get_forecast after list_changed (task Verify)", async () => {
    const { code, messages } = await run(evil, [
      request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      request(2, "tools/list"),
      alerts(3),
      alerts(4),
      alerts(5),
      (out) => waitFor(() => out().includes("notifications/tools/list_changed")),
      request(6, "tools/call", { name: "get_forecast", arguments: { latitude: 1, longitude: 2 } }),
      (out) => waitFor(() => out().includes('"id":6')),
    ]);
    expect(code).toBe(0);
    expect(messages.map((m) => m.id ?? m.method)).toEqual([1, 2, 3, 4, 5, "notifications/tools/list_changed", 6]);
    for (const m of messages.slice(2, 5)) expect(m.result).toMatchObject({ isError: false });
    const pending = await readPending(stateDir);
    const forecast = pending.find((c) => c.toolName === "get_forecast")!;
    expect(forecast.tier).toBe(3);
    expect(messages[6]).toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: {
        code: -32001,
        message: 'LatchVerify blocked "get_forecast" pending review — run `latch review`',
        data: { reason: { kind: "hard_block", changeId: forecast.id } },
      },
    });
    const kinds = (await readEvents(stateDir)).map((e) => e.kind);
    expect(kinds).toContain("list_changed");
    expect(kinds).toContain("call_blocked");
    expect(stderr.join("")).toContain("[evil-server] rug pull after 3 tools/call requests");
  }, 30_000);

  it("starts the server without LatchVerify's LATCH_* variables", async () => {
    vi.stubEnv("LATCH_LLM_API_KEY", "secret-key");
    vi.stubEnv("LATCH_LOCKFILE_PATH", lockfilePath);
    vi.stubEnv("LATCH_STATE_DIR", stateDir);
    const envServer = `require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line);
      const own = Object.keys(process.env).filter((k) => /^latch_/i.test(k));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { own } }) + "\\n");
    });`;
    try {
      const { messages } = await run({ args: ["-e", envServer] }, [request(1, "env/dump"), (out) => waitFor(() => out().includes('"id":1'))]);
      expect(messages.find((m) => m.id === 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { own: [] } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops a server that writes a line longer than maxLineBytes", async () => {
    const flood = `process.stdout.write('{"jsonrpc":"2.0","method":"x","pad":"' + "a".repeat(4096)); setInterval(() => {}, 1000);`;
    const { code } = await run({ args: ["-e", flood] }, [(out) => waitFor(() => stderr.join("").includes("longer than"))], {
      maxLineBytes: 1024,
    });
    expect(code).toBe(128 + 15);
    expect(stderr.join("")).toContain("[latch] warning: the server wrote a line longer than 1024 bytes; stopping it");
  });

  it("sends SIGTERM to a server that keeps running after its input closed", async () => {
    const { code } = await run({ args: ["-e", "setInterval(() => {}, 1000)"] }, [], { exitGraceMs: 100 });
    expect(code).toBe(128 + 15);
    expect(stderr.join("")).toContain("[latch] warning: the server is still running 100 ms after its input closed; sending SIGTERM");
  });

  // Windows has no catchable SIGTERM: child.kill() always terminates the process there.
  it.skipIf(process.platform === "win32")("sends SIGKILL to a server that ignores SIGTERM", async () => {
    const stubborn = 'process.on("SIGTERM", () => {}); process.stdout.write("{}\\n"); setInterval(() => {}, 1000)';
    const { code } = await run({ args: ["-e", stubborn] }, [(out) => waitFor(() => out().includes("{}"))], { exitGraceMs: 100 });
    expect(code).toBe(128 + 9);
    expect(stderr.join("")).toContain("[latch] warning: the server is still running 100 ms after SIGTERM; sending SIGKILL");
  });

  it("never lets a tier-3 tool's description reach the client", async () => {
    const poisoned = JSON.parse(readFileSync(join(root, "tests/fixtures/poisoned-tools.json"), "utf8")).tools as Array<{ name: string; description: string }>;
    const { messages, text } = await run({ args: ["-e", echoServer(poisoned)] }, [request(1, "tools/list"), (out) => waitFor(() => out().includes('"id":1'))]);
    const listed = (messages.find((m) => m.id === 1)!.result as { tools: Array<{ name: string; description: string }> }).tools;
    const forecast = poisoned.find((t) => t.name === "get_forecast")!;
    expect(listed.find((t) => t.name === "get_forecast")!.description).toMatch(/^\[LatchVerify\] This tool's definition was withheld/);
    expect(text).not.toContain(forecast.description);
  });

  it("follows the log level: debug names frames, warn leaves out routine lines", async () => {
    await run(echo, [request(1, "tools/call", { name: "nope", arguments: {} }), (out) => waitFor(() => out().includes('"id":1'))], {
      logLevel: "debug",
      holdTimeoutMs: 50,
    });
    const debug = stderr.join("");
    expect(debug).toContain("[latch] debug: holding tools/call #1 until the server's tools are verified");
    expect(debug).toContain("[latch] debug: client->server tools/call #1: respond");
    stderr.length = 0;
    await run(echo, [request(1, "tools/call", { name: "nope", arguments: {} }), (out) => waitFor(() => out().includes('"id":1'))], {
      logLevel: "warn",
      holdTimeoutMs: 50,
    });
    expect(stderr.join("")).not.toContain("[latch] blocked");
    expect(stderr.join("")).toContain("[latch] warning: tools still unverified after 50 ms");
  });

  it("forwards unknown fields byte-for-byte in both directions", async () => {
    const sent = '{"jsonrpc":"2.0",  "id":1, "method":"echo", "x-extra":{"kept":true}, "n":1.50}';
    const { messages, text } = await run(echo, [sent, (out) => waitFor(() => out().includes('"id":1'))]);
    expect(text.startsWith('{ "jsonrpc" : "2.0", "method":"notifications/custom", "x-vendor":{"a":[1, 2.50]} }\n')).toBe(true);
    expect(messages.find((m) => m.id === 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { raw: sent } });
  });

  it("never lets a blocked call reach the server", async () => {
    const { messages } = await run(echo, [
      request(1, "tools/list"),
      request(2, "tools/call", { name: "get_alerts", arguments: {} }),
      request(3, "tools/call", { name: "delete_everything", arguments: {} }),
      request(4, "ping"),
      (out) => waitFor(() => out().includes('"id":4')),
    ]);
    expect(messages.filter((m) => m.id === 3)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: -32001, data: { reason: { kind: "unpinned" } } }) }),
    ]);
    expect(messages.find((m) => m.id === 2)).toMatchObject({ result: { raw: expect.stringContaining("get_alerts") } });
    // The block is answered at once, so it may overtake the server's replies.
    expect(messages.map((m) => m.id ?? m.method).sort()).toEqual([1, 2, 3, 4, "notifications/custom"]);
  });

  it("holds calls made before any tool list, then blocks them as unverified on timeout, in order", async () => {
    const { messages } = await run(
      echo,
      [
        request(1, "tools/call", { name: "get_alerts", arguments: {} }),
        request(2, "ping"),
        request(3, "tools/call", { name: "get_alerts", arguments: {} }),
        (out) => waitFor(() => out().includes('"id":3')),
      ],
      { holdTimeoutMs: 200 },
    );
    const replies = messages.filter((m) => m.id !== undefined);
    // The ping is not a call, so it is not held behind them.
    expect(replies.map((m) => m.id)).toEqual([2, 1, 3]);
    expect(replies[1]).toMatchObject({ error: { code: -32001, data: { reason: { kind: "unverified" } } } });
    expect(replies[2]).toMatchObject({ error: { code: -32001, data: { reason: { kind: "unverified" } } } });
    expect(stderr.join("")).toContain("releasing 2 held client frames");
  });

  it("passes the client's answer to a server request while a call is held", async () => {
    // Asks the client for its roots and lists its tools only once it has the answer.
    const asking = `const tools = ${JSON.stringify(benignTools)};
let answered = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" });
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === "roots-1") { answered = true; return; }
  if (m.method === "tools/list") return answered ? send({ jsonrpc: "2.0", id: m.id, result: { tools } }) : send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no roots yet" } });
  if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [], isError: false } });
});`;
    const { messages } = await run(
      { args: ["-e", asking] },
      [
        (out) => waitFor(() => out().includes("roots/list")),
        request(1, "tools/call", { name: "get_alerts", arguments: {} }),
        line({ jsonrpc: "2.0", id: "roots-1", result: { roots: [] } }),
        request(2, "tools/list"),
        (out) => waitFor(() => out().includes('"id":1')),
      ],
      { holdTimeoutMs: 10_000 },
    );
    expect(messages.find((m) => m.id === 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [], isError: false } });
  });

  it("verifies on notifications/initialized so an early call goes through", async () => {
    const { messages } = await run(echo, [
      request(1, "initialize", {}),
      line({ jsonrpc: "2.0", method: "notifications/initialized" }),
      request(2, "tools/call", { name: "get_alerts", arguments: {} }),
      (out) => waitFor(() => out().includes('"id":2')),
    ]);
    expect(messages.find((m) => m.id === 2)).toMatchObject({ result: { raw: expect.stringContaining("get_alerts") } });
    // The proxy's own tools/list answer is never forwarded.
    expect(messages.filter((m) => typeof m.id === "string")).toEqual([]);
  });

  it("refuses a batch from the client", async () => {
    const { messages } = await run(echo, [line([JSON.parse(request(1, "ping"))]), (out) => waitFor(() => out().includes("batches"))]);
    expect(messages.find((m) => m.id === null)).toMatchObject({ error: { code: -32600 } });
  });

  it("resolves with the server's exit code", async () => {
    expect((await run({ args: ["-e", "process.exit(3)"] }, [])).code).toBe(3);
  });

  it.skipIf(process.platform === "win32")("passes SIGTERM on to the server", async () => {
    const { code } = await run({ args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"] }, [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        process.emit("SIGTERM");
      },
    ]);
    expect(code).toBe(143);
  });

  it("rejects when the server cannot be started", async () => {
    await expect(run({ command: "latch-no-such-binary-for-test", args: [] }, [])).rejects.toThrow(
      /^could not start latch-no-such-binary-for-test: /,
    );
  });

  it("rejects a malformed lockfile instead of running without state", async () => {
    const bad = join(stateDir, "latch.lock");
    await writeFile(bad, "{ nope");
    await expect(run(echo, [], { lockfilePath: bad })).rejects.toThrow();
  });
});

describe("tamper detection", () => {
  it("keeps blocking when latch.lock is edited behind LatchVerify's back, until the edit is accepted", async () => {
    const lock = join(stateDir, "latch.lock");
    await writeLockfile(lock, await readLockfile(lockfilePath));
    const readConfig = (JSON.parse(readFileSync(join(root, "tests/fixtures/poisoned-tools.json"), "utf8")).tools as Array<{ name: string }>).find(
      (t) => t.name === "read_config",
    )!;
    const callReadConfig = (id: number) => request(id, "tools/call", { name: "read_config", arguments: {} });
    const { messages } = await run(
      { args: ["-e", echoServer([...benignTools, readConfig])] },
      [
        request(1, "tools/list"),
        (out) => waitFor(() => out().includes('"id":1')),
        // A server running as the same user approves its own change by editing latch.lock.
        async () => {
          const [change] = await readPending(stateDir);
          const approved = applyApproval(await readLockfile(lock), change!, "attacker", new Date());
          await writeFile(lock, serializeLockfile(approved));
        },
        callReadConfig(2),
        (out) => waitFor(() => out().includes('"id":2')),
        async () => {
          expect(await runLockAccept({ lockfilePath: lock, output: new PassThrough() })).toBe(0);
        },
        callReadConfig(3),
        (out) => waitFor(() => out().includes('"id":3')),
      ],
      { lockfilePath: lock },
    );
    expect(messages.find((m) => m.id === 2)).toMatchObject({ error: { code: -32001, data: { reason: { kind: "pending_review" } } } });
    expect(messages.find((m) => m.id === 3)).toMatchObject({ result: { raw: expect.stringContaining("read_config") } });
    expect(stderr.join("")).toContain(`[latch] warning: ${lock} was changed outside LatchVerify`);
    expect((await readEvents(stateDir)).filter((e) => e.kind === "lock_tampered")).toEqual([
      { kind: "lock_tampered", at: expect.any(String), serverId: "weather", path: lock },
    ]);
  });

  it("starts from the last trusted copy when latch.lock was edited while no proxy ran", async () => {
    const lock = join(stateDir, "latch.lock");
    const trusted = await readLockfile(lockfilePath);
    await writeLockfile(lock, trusted);
    const emptied = { ...trusted, servers: {} };
    await writeFile(lock, serializeLockfile(emptied));
    const { messages } = await run(echo, [request(1, "tools/list"), alerts(2), (out) => waitFor(() => out().includes('"id":2'))], {
      lockfilePath: lock,
    });
    // get_alerts is pinned in the trusted copy, so it still works; the edit is not adopted.
    expect(messages.find((m) => m.id === 2)).toMatchObject({ result: { raw: expect.stringContaining("get_alerts") } });
    expect((await readEvents(stateDir)).map((e) => e.kind)).toContain("lock_tampered");
  });
});

describe("latch proxy process", () => {
  it("writes nothing but JSON-RPC to stdout", async () => {
    const script = `import { startProxy } from ${JSON.stringify(pathToFileURL(join(root, "src/proxy/index.ts")).href)};
startProxy({ serverId: "weather", command: process.execPath, args: ["--import", "tsx", ${JSON.stringify(join(root, "demo/weather-server.ts"))}],
  lockfilePath: ${JSON.stringify(lockfilePath)}, stateDir: ${JSON.stringify(stateDir)} }).then((code) => process.exit(code));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stdin.write(`${request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })}\n`);
    child.stdin.write(`${line({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${request(2, "tools/list")}\n`);
    child.stdin.write(`${request(3, "tools/call", { name: "nope", arguments: {} })}\n`);
    await waitFor(() => stdout.includes('"id":3'));
    child.stdin.end();
    const [code] = (await once(child, "close")) as [number];
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id).sort()).toEqual([1, 2, 3]);
    expect(await readFile(join(stateDir, "events.jsonl"), "utf8")).toContain('"call_blocked"');
  }, 30_000);
});

describe("decisions made by latch review while the proxy runs", () => {
  const extra = { name: "extra_tool", description: "Does extra things.", inputSchema: { type: "object" } };
  const withExtra = { args: ["-e", echoServer([...benignTools, extra])] };
  const callExtra = (id: number) => request(id, "tools/call", { name: "extra_tool", arguments: {} });

  it("applies an approval to the next call without a restart", async () => {
    const lock = join(stateDir, "latch.lock");
    await writeFile(lock, await readFile(lockfilePath, "utf8"));
    const { messages } = await run(
      withExtra,
      [
        request(1, "tools/list"),
        callExtra(2),
        (out) => waitFor(() => out().includes('"id":2')),
        async () => {
          // What `latch review` does on approve.
          const [change] = await readPending(stateDir);
          await writeLockfile(lock, applyApproval(await readLockfile(lock), change!, "dev@example.com", new Date()));
          await writePending(stateDir, dequeue(await readPending(stateDir), change!.id));
        },
        callExtra(3),
        (out) => waitFor(() => out().includes('"id":3')),
      ],
      { lockfilePath: lock },
    );
    expect(messages.find((m) => m.id === 2)).toMatchObject({ error: { data: { reason: { kind: "unpinned" } } } });
    expect(messages.find((m) => m.id === 3)).toMatchObject({ result: { raw: expect.stringContaining("extra_tool") } });
  });

  it("keeps the last good lockfile when a malformed one is written", async () => {
    const lock = join(stateDir, "latch.lock");
    await writeFile(lock, await readFile(lockfilePath, "utf8"));
    const { messages } = await run(
      echo,
      [
        request(1, "tools/list"),
        (out) => waitFor(() => out().includes('"id":1')),
        () => writeFile(lock, "{ broken"),
        request(2, "tools/call", { name: "get_alerts", arguments: {} }),
        request(3, "tools/call", { name: "get_alerts", arguments: {} }),
        (out) => waitFor(() => out().includes('"id":3')),
      ],
      { lockfilePath: lock },
    );
    expect(messages.find((m) => m.id === 2)).toMatchObject({ result: { raw: expect.any(String) } });
    expect(messages.find((m) => m.id === 3)).toMatchObject({ result: { raw: expect.any(String) } });
    expect(stderr.join("").match(/kept the previous latch\.lock/g)).toHaveLength(1);
  });
});
