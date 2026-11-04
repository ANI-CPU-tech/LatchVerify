import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkLinked, checkPinned, checkUnlinked, stubClientConfig } from "../../packaging/test/check-link.js";

const lockfile = "/home/dev/.config/latchverify/latch.lock";
const linked = {
  mcpServers: {
    stub: { command: "/opt/node", args: ["/opt/cli.js", "--lockfile", lockfile, "--state-dir", "/x", "proxy", "--server", "stub", "--", "node", "stub.mjs"], env: { KEY: "k" } },
  },
};
const lock = { servers: { stub: { tools: [{ name: "echo" }] } } };
const firstRun = { servers: { stub: { tools: [], trustOnFirstUse: true } } };

describe("checkLinked", () => {
  it("passes for a wrapped entry its lockfile lists, pinned or waiting for its first run", () => {
    expect(checkLinked(linked, lock, "stub", lockfile)).toBeNull();
    expect(checkLinked(linked, firstRun, "stub", lockfile)).toBeNull();
  });

  it("names what is wrong otherwise", () => {
    expect(checkLinked({ mcpServers: {} }, lock, "stub", lockfile)).toMatch(/no "stub" entry/);
    expect(checkLinked({ mcpServers: { stub: { command: "node", args: ["stub.mjs"] } } }, lock, "stub", lockfile)).toMatch(/does not start latch proxy/);
    expect(checkLinked(linked, lock, "stub", "/other/latch.lock")).toMatch(/does not pass --lockfile \/other\/latch\.lock/);
    expect(checkLinked({ mcpServers: { stub: { ...linked.mcpServers.stub, env: { LATCH_STATE_DIR: "/x" } } } }, lock, "stub", lockfile)).toMatch(/has LATCH_STATE_DIR in its env/);
    expect(checkLinked(linked, { servers: {} }, "stub", lockfile)).toMatch(/does not list "stub"/);
  });
});

describe("checkPinned", () => {
  it("passes once the first run pinned the tools, not before", () => {
    expect(checkPinned(lock, "stub")).toBeNull();
    expect(checkPinned(firstRun, "stub")).toMatch(/pins no tool/);
    expect(checkPinned({ servers: { stub: { tools: [{ name: "echo" }], trustOnFirstUse: true } } }, "stub")).toMatch(/still marked/);
    expect(checkPinned({ servers: {} }, "stub")).toMatch(/does not list/);
  });
});

describe("checkUnlinked", () => {
  it("passes for a restored entry and fails for a wrapped one or leftover variables", () => {
    expect(checkUnlinked({ mcpServers: { stub: { command: "node", args: ["stub.mjs"] } } }, "stub")).toBeNull();
    expect(checkUnlinked(linked, "stub")).toMatch(/still starts latch proxy/);
    expect(checkUnlinked({ mcpServers: { stub: { command: "node", env: { LATCH_STATE_DIR: "/x" } } } }, "stub")).toMatch(/LATCH_STATE_DIR/);
  });
});

describe("stubClientConfig", () => {
  it("runs the stub server with this Node.js, by absolute paths", () => {
    const entry = stubClientConfig("stub").mcpServers.stub!;
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toHaveLength(1);
    expect(entry.args![0]).toMatch(/stub-server\.mjs$/);
    expect(existsSync(entry.args![0]!)).toBe(true);
  });
});
