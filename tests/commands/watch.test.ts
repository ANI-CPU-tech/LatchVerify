import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWatch } from "../../src/commands/watch.js";
import { clientConfigPath } from "../../src/config/clients.js";
import { emptyLockfile, writeLockfile } from "../../src/store/lockfile.js";
import { updateSettings } from "../../src/store/settings.js";

const tools = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/benign-tools.json", import.meta.url)), "utf8")).tools;
const stub = {
  command: process.execPath,
  args: ["-e", `const tools = ${JSON.stringify(tools)};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }) + "\\n");
});`],
};

describe.skipIf(process.platform === "win32")("latch watch --once", { timeout: 30_000 }, () => {
  let home: string;
  let lockfilePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-watch-cmd-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    lockfilePath = join(home, ".config", "latchverify", "latch.lock");
    await mkdir(dirname(lockfilePath), { recursive: true });
    await writeLockfile(lockfilePath, emptyLockfile());
    await updateSettings(join(dirname(lockfilePath), "settings.json"), { clients: { cursor: true } });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function once() {
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    const code = await runWatch({ lockfilePath, stateDir: join(dirname(lockfilePath), ".latch"), once: true, notify: false, logLevel: "error", output });
    return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  it("syncs once, says what it did, then says there is nothing left to do", async () => {
    const path = clientConfigPath("cursor");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { weather: stub } }));
    const first = await once();
    expect(first.code).toBe(0);
    expect(first.text).toContain("✔ added weather to latch.lock; its tools are pinned the first time it runs");
    expect(first.text).toContain(`✔ linked weather in ${path}`);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.weather.args).toContain("proxy");
    expect(await once()).toEqual({ code: 0, text: "every MCP client is linked; nothing to change\n" });
  });

  it("exits 1 when a config cannot be read", async () => {
    const path = clientConfigPath("cursor");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ broken");
    const { code, text } = await once();
    expect(code).toBe(1);
    expect(text).toContain(`! cursor: ${path} is not valid JSON`);
  });
});
