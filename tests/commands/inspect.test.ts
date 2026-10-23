import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCapabilitySet } from "../../src/analyze/capabilities.js";
import {
  INSPECT_EXIT,
  INSPECT_REPORT_VERSION,
  describeAnnotations,
  describeCapabilities,
  runInspect,
  type InspectOptions,
  type InspectReport,
} from "../../src/commands/inspect.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name: string) => join(root, "tests/fixtures", name);
// Absolute, so children started outside the repo still find tsx.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-inspect-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Run inspect and return its exit code and text, without ANSI colours. */
async function inspect(options: Omit<InspectOptions, "json" | "output">) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await runInspect({ json: false, output, timeoutMs: 20_000, ...options });
  return { code, text: text.replace(/\x1b\[[0-9;]*m/g, "") };
}

/** Run inspect --json and return its exit code and parsed report. */
async function inspectJson(options: Omit<InspectOptions, "json" | "output">) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const code = await runInspect({ json: true, output, timeoutMs: 20_000, ...options });
  return { code, text, report: JSON.parse(text) as InspectReport };
}

/** The block of text describing one tool. */
const section = (text: string, name: string) => text.split("\n\n").find((block) => block.startsWith(`${name}\n`)) ?? "";

describe("runInspect --file", () => {
  it("lists capabilities, claims and findings for all 4 poisoned tools (task Verify)", async () => {
    const { code, text } = await inspect({ file: fixture("poisoned-tools.json") });
    expect(code).toBe(INSPECT_EXIT.hardBlock);
    expect(text.startsWith(`latch inspect: 4 tools from ${fixture("poisoned-tools.json")}\n`)).toBe(true);

    const forecast = section(text, "get_forecast");
    expect(forecast).toContain("capabilities  network egress");
    expect(forecast).toContain("annotations   readOnlyHint, openWorldHint (claims, not checked)");
    expect(forecast).toContain("findings      5 critical, 1 other");
    expect(forecast).toContain('✖ pattern  Text points the model at a sensitive file (description): "~/.ssh/id_rsa"');
    expect(forecast).toContain("! unicode  8 invisible characters in description");
    expect(forecast).toContain("first seen    tier 3, hard block  Critical pattern finding");

    expect(section(text, "read_config")).toContain("capabilities  filesystem read (unconstrained)");
    expect(section(text, "read_config")).toContain("first seen    tier 2, held for review  Gained filesystem.read");
    expect(section(text, "run_diagnostics")).toContain("capabilities  exec through a shell");
    expect(section(text, "run_diagnostics")).toContain("! annotation_mismatch  Tool claims to be read-only but can execute commands");
    expect(section(text, "sync_alerts")).toContain("capabilities  network egress to any URL");
    expect(section(text, "sync_alerts")).toContain('decodes to "hi"');
    expect(text.trimEnd().endsWith("✖ 3 tools would be hard-blocked at tier 3 (exit 2)")).toBe(true);
  });

  it("reports the benign tools as clean", async () => {
    const { code, text } = await inspect({ file: fixture("benign-tools.json") });
    expect(code).toBe(INSPECT_EXIT.ok);
    for (const name of ["get_forecast", "get_alerts"]) {
      expect(section(text, name)).toContain("findings      none");
      expect(section(text, name)).toContain("first seen    tier 2, held for review  Gained network.egress");
    }
    expect(text.trimEnd().endsWith("✔ no tool would be hard-blocked (exit 0)")).toBe(true);
  });

  it("accepts a whole JSON-RPC response, a bare array and a byte-order mark", async () => {
    const tools = [{ name: "plain", inputSchema: { type: "object" } }];
    for (const [i, contents] of [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }),
      JSON.stringify(tools),
      `﻿${JSON.stringify({ tools })}`,
    ].entries()) {
      const path = join(dir, `t${i}.json`);
      await writeFile(path, contents);
      const { code, text } = await inspect({ file: path });
      expect(code, contents).toBe(INSPECT_EXIT.ok);
      expect(text).toContain("latch inspect: 1 tool from");
    }
  });

  it("counts entries without a usable name and hard-blocks a duplicated name", async () => {
    const path = join(dir, "odd.json");
    const tool = { name: "twice", inputSchema: { type: "object" } };
    await writeFile(path, JSON.stringify({ tools: [tool, tool, { description: "nameless" }, null] }));
    const { code, text } = await inspect({ file: path });
    expect(code).toBe(INSPECT_EXIT.hardBlock);
    expect(text).toContain("! ignored 2 list entries without a usable name");
    expect(section(text, "twice")).toContain("the tool is listed 2 times");
  });

  it("exits 3 for a missing, unparseable or wrongly shaped file", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ nope");
    const shape = join(dir, "shape.json");
    await writeFile(shape, JSON.stringify({ result: { items: [] } }));
    const cases: Array<[string, RegExp]> = [
      [join(dir, "missing.json"), /ENOENT/],
      [bad, /is not valid JSON/],
      [shape, /does not hold a tools\/list result/],
    ];
    for (const [file, message] of cases) {
      const { code, text } = await inspect({ file });
      expect(code, file).toBe(INSPECT_EXIT.error);
      expect(text).toMatch(message);
      expect(text.trimEnd().endsWith("✖ error (exit 3)")).toBe(true);
    }
  });

  it("never prints a tool's control characters to the terminal", async () => {
    const path = join(dir, "hostile.json");
    await writeFile(path, JSON.stringify({ tools: [{ name: "evil\u001b[2J‮tool", inputSchema: { type: "object" } }] }));
    const { text } = await inspect({ file: path });
    expect(text).not.toMatch(/[\u001b‮]/);
    expect(text).toContain("evil[U+001B][2J[U+202E]tool");
  });
});

describe("runInspect with a live server", () => {
  const weather = [process.execPath, "--import", tsx, join(root, "demo/weather-server.ts")];

  it("gives the same result as the server's tools in a file", async () => {
    const live = await inspect({ server: weather });
    const file = await inspect({ file: fixture("benign-tools.json") });
    expect(live.code).toBe(INSPECT_EXIT.ok);
    const body = (text: string) => text.slice(text.indexOf("\n"));
    expect(body(live.text)).toBe(body(file.text));
    expect(live.text).toContain(`from ${weather.join(" ")}`);
  });

  it("exits 3 when the server cannot be started", async () => {
    const { code, text } = await inspect({ server: ["latch-no-such-binary-for-test"] });
    expect(code).toBe(INSPECT_EXIT.error);
    expect(text).toContain("could not start latch-no-such-binary-for-test");
  });

  it("needs exactly one of --file and a server command", async () => {
    for (const options of [{}, { server: [] }, { file: fixture("benign-tools.json"), server: weather }]) {
      const { code, text } = await inspect(options);
      expect(code, JSON.stringify(options)).toBe(INSPECT_EXIT.error);
      expect(text).toContain("give either --file <path> or a server command after --, not both");
    }
  });

  it("writes nothing to disk", async () => {
    const script = `import { runInspect } from ${JSON.stringify(join(root, "src/commands/inspect.ts"))};
await runInspect({ file: ${JSON.stringify(fixture("poisoned-tools.json"))}, json: false });
process.exitCode = await runInspect({ server: ${JSON.stringify(weather)}, json: false });`;
    const child = spawn(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { cwd: dir, stdio: "ignore" });
    const [code] = (await once(child, "close")) as [number];
    expect(code).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  }, 30_000);
});

describe("describeCapabilities", () => {
  it("summarizes every kind of capability", () => {
    const caps = emptyCapabilitySet();
    expect(describeCapabilities(caps)).toBe("none");
    caps.filesystem = { read: true, write: true, scope: "constrained", paths: ["/srv/data"] };
    caps.exec = { enabled: true, shell: false };
    caps.network = { egress: true, domains: ["api.example.com"], unconstrained: false };
    caps.credentials = { readsEnv: true, readsSecrets: true };
    caps.crossServerRefs = ["send_email"];
    expect(describeCapabilities(caps)).toBe(
      "filesystem read and write (constrained: /srv/data), exec, network egress to api.example.com, reads environment variables, reads secrets, names other servers' tools: send_email",
    );
  });
});

describe("describeAnnotations", () => {
  it("lists true claims by name and false ones with their value", () => {
    expect(describeAnnotations({})).toBe("none");
    expect(describeAnnotations({ readOnlyHint: true, destructiveHint: false, openWorldHint: undefined })).toBe(
      "readOnlyHint, destructiveHint: false",
    );
  });
});

describe("runInspect --json", () => {
  it("reports the benign file as one clean JSON document (task Verify)", async () => {
    const { code, report, text } = await inspectJson({ file: fixture("benign-tools.json") });
    expect(code).toBe(INSPECT_EXIT.ok);
    expect(text.endsWith("}\n")).toBe(true);
    expect(report).toMatchObject({
      version: INSPECT_REPORT_VERSION,
      source: { file: fixture("benign-tools.json") },
      specVersion: null,
      status: "ok",
      exitCode: 0,
      ignored: 0,
    });
    expect(report.tools.map((t) => [t.name, t.tier, t.findings])).toEqual([
      ["get_forecast", 2, []],
      ["get_alerts", 2, []],
    ]);
    expect(report.tools[0]!.capabilities).toMatchObject({ network: { egress: true }, declared: { readOnlyHint: true, openWorldHint: true } });
  });

  it("carries every finding for the poisoned tools", async () => {
    const { code, report } = await inspectJson({ file: fixture("poisoned-tools.json") });
    expect(code).toBe(INSPECT_EXIT.hardBlock);
    expect(report.status).toBe("hard_block");
    expect(report.tools.map((t) => [t.name, t.tier, t.findings.length])).toEqual([
      ["get_forecast", 3, 6],
      ["read_config", 2, 0],
      ["run_diagnostics", 3, 5],
      ["sync_alerts", 3, 2],
    ]);
    expect(report.tools[0]!.reason).toMatch(/^Critical pattern finding/);
  });

  it("names the live server and its protocol version", async () => {
    const command = [process.execPath, "--import", tsx, join(root, "demo/weather-server.ts")];
    const { report } = await inspectJson({ server: command });
    expect(report.source).toEqual({ command });
    expect(report.specVersion).toBe("2025-06-18");
    const file = await inspectJson({ file: fixture("benign-tools.json") });
    expect(report.tools).toEqual(file.report.tools);
  });

  it("reports errors in the same shape", async () => {
    const missing = join(dir, "missing.json");
    const { code, report } = await inspectJson({ file: missing });
    expect(code).toBe(INSPECT_EXIT.error);
    expect(report).toEqual({
      version: INSPECT_REPORT_VERSION,
      source: { file: missing },
      specVersion: null,
      status: "error",
      exitCode: 3,
      error: expect.stringContaining("ENOENT"),
      ignored: 0,
      tools: [],
    });
  });

  it("keeps tool strings verbatim, escaped only by JSON", async () => {
    const path = join(dir, "hostile.json");
    await writeFile(path, JSON.stringify({ tools: [{ name: "evil\u001btool", inputSchema: { type: "object" } }] }));
    const { report, text } = await inspectJson({ file: path });
    expect(text).not.toContain("\u001b");
    expect(report.tools[0]!.name).toBe("evil\u001btool");
  });
});

describe("latch inspect (CLI)", () => {
  it("passes the server's own flags through instead of parsing them as inspect options", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, join(root, "src/cli.ts"), "inspect", "--json", process.execPath, "--import", tsx, join(root, "demo/weather-server.ts")],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.stderr).not.toContain("unknown option");
    expect(result.status).toBe(0);
    expect(JSON.stringify(JSON.parse(result.stdout))).toContain("get_forecast");
  }, 30_000);
});
