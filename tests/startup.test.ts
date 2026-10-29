import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every wrapped MCP server keeps a `latch proxy` process running, so whatever `latch` loads at
// startup is paid once per server. These tests pin the startup import graph: a command's module is
// imported when that command runs (src/cli.ts), and the modules every command needs stay light.

const src = fileURLToPath(new URL("../src/", import.meta.url));

/** The modules `file` imports statically (type-only imports excluded), relative paths resolved inside src/. */
function staticImports(file: string): string[] {
  const text = readFileSync(join(src, file), "utf8");
  return [...text.matchAll(/^import (?!type )[^"]*?from "([^"]+)";$/gm)].map(([, spec]) =>
    spec!.startsWith(".") ? relative(src, resolve(dirname(join(src, file)), spec!)) : spec!,
  );
}

/** Every module reachable from `file` through static imports, package names included. */
function startupGraph(file: string, seen = new Set<string>()): Set<string> {
  for (const spec of staticImports(file)) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (spec.endsWith(".js")) startupGraph(spec.replace(/\.js$/, ".ts"), seen);
  }
  return seen;
}

describe("latch at startup", () => {
  it("loads only the CLI parser and the light modules every command needs", () => {
    expect([...startupGraph("cli.ts")].sort()).toEqual([
      "analyze/llm-defaults.js",
      "commander",
      "commands/exit-codes.js",
      "config/client-ids.js",
      "config/env.js",
      "config/paths.js",
      "node:fs",
      "node:os",
      "node:path",
      "node:util",
      "picocolors",
      "version.js",
    ]);
  });

  it("keeps the review UI's server and the prompts out of the background watcher", () => {
    const graph = startupGraph("commands/watch.ts");
    for (const heavy of ["hono", "@hono/node-server", "@clack/prompts", "ui/server.js"]) expect(graph.has(heavy), heavy).toBe(false);
  });

  it("leaves the LLM client out of a proxy that does not use it", () => {
    expect(startupGraph("commands/proxy.ts").has("analyze/llm.js")).toBe(false);
  });
});
