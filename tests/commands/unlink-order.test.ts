import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answersWhenRestoring: unknown[] = [];
let settingsFile = "";

// What the settings say at the moment a config is rewritten: a sync running then must see the no.
vi.mock("../../src/config/clients.js", async (original) => {
  const actual = await original<typeof import("../../src/config/clients.js")>();
  return {
    ...actual,
    writeClientConfig: async (config: Parameters<typeof actual.writeClientConfig>[0]) => {
      const text = await readFile(settingsFile, "utf8").catch(() => "{}");
      answersWhenRestoring.push(text.startsWith("{ damaged") ? "damaged" : JSON.parse(text).clients?.cursor);
      return actual.writeClientConfig(config);
    },
  };
});

const { runUnlink } = await import("../../src/commands/setup.js");
const { clientConfigPath } = await import("../../src/config/clients.js");

describe.skipIf(process.platform === "win32")("disconnecting a client", () => {
  let home: string;
  const wrapped = { command: "latch", args: ["proxy", "--server", "weather", "--", "npx", "weather"] };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "latch-unlink-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    settingsFile = join(home, "settings.json");
    answersWhenRestoring.length = 0;
    await mkdir(dirname(clientConfigPath("cursor")), { recursive: true });
    await writeFile(clientConfigPath("cursor"), JSON.stringify({ mcpServers: { weather: wrapped } }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("saves the no before restoring, so a sync in between cannot wrap the client again", async () => {
    await writeFile(settingsFile, JSON.stringify({ clients: { cursor: true } }));
    expect(await runUnlink({ client: "cursor", dryRun: false, output: new PassThrough(), settingsPath: settingsFile })).toBe(0);
    expect(answersWhenRestoring).toEqual([false]);
  });

  it("still restores the client when the answer cannot be saved, as an uninstaller needs", async () => {
    await writeFile(settingsFile, "{ damaged");
    expect(await runUnlink({ client: "cursor", dryRun: false, output: new PassThrough(), settingsPath: settingsFile })).toBe(1);
    expect(JSON.parse(await readFile(clientConfigPath("cursor"), "utf8")).mcpServers.weather).toEqual({ command: "npx", args: ["weather"] });
  });
});
