import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkLinked, checkUnlinked, stubClientConfig } from "../../packaging/test/check-link.js";

const lockfile = "/home/dev/.config/latchverify/latch.lock";
const linked = {
  mcpServers: {
    stub: { command: "/opt/node", args: ["/opt/cli.js", "proxy", "--server", "stub", "--", "node", "stub.mjs"], env: { LATCH_LOCKFILE_PATH: lockfile, LATCH_STATE_DIR: "/x" } },
  },
};
const lock = { servers: { stub: { tools: [{ name: "echo" }] } } };

describe("checkLinked", () => {
  it("passes for a wrapped entry with its tools pinned", () => {
    expect(checkLinked(linked, lock, "stub", lockfile)).toBeNull();
  });

  it("names what is wrong otherwise", () => {
    expect(checkLinked({ mcpServers: {} }, lock, "stub", lockfile)).toMatch(/no "stub" entry/);
    expect(checkLinked({ mcpServers: { stub: { command: "node", args: ["stub.mjs"] } } }, lock, "stub", lockfile)).toMatch(/does not start latch proxy/);
    expect(checkLinked(linked, lock, "stub", "/other/latch.lock")).toMatch(/LATCH_LOCKFILE_PATH/);
    expect(checkLinked(linked, { servers: {} }, "stub", lockfile)).toMatch(/pins no tool/);
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
