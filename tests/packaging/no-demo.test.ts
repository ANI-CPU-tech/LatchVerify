import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

// What every package ships is `pnpm build` output (packaging/stage.ts): dist/ for the CLI and
// dist/web for the review UI. Demo material (demo/, tests/fixtures, web/src/lib/mock.ts) stays in
// the repository for development and must not reach either.

const root = fileURLToPath(new URL("../../", import.meta.url));

/** In web/src/lib/mock.ts only: the sample queue's approver. */
const MOCK_MARKER = "alice@example.com";
/** A tool description from tests/fixtures/benign-tools.json, which the Simulation page plays. */
const FIXTURE_MARKER = "Get active weather alerts for a US state.";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));

describe("the CLI build", () => {
  it("compiles src/ only", () => {
    const config = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8")) as { include: string[]; compilerOptions: { rootDir: string } };
    expect(config.include).toEqual(["src"]);
    expect(config.compilerOptions.rootDir).toBe("./src");
  });

  it("never imports from outside src/, so demo/ and tests/ cannot be pulled in", () => {
    const src = join(root, "src");
    const escapes: string[] = [];
    for (const file of sourceFiles(src)) {
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
        const target = resolve(dirname(file), specifier!);
        if (target !== src && !target.startsWith(src + sep)) escapes.push(`${relative(root, file)}: ${specifier}`);
      }
    }
    expect(escapes).toEqual([]);
  });
});

describe("the production web build", () => {
  it("has no sample data, and loads the demo fixtures only in the Simulation chunk", async () => {
    const out = await mkdtemp(join(tmpdir(), "latch-web-build-"));
    try {
      await build({ configFile: join(root, "web/vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
      const assets = join(out, "assets");
      const chunks = (await readdir(assets)).filter((name) => name.endsWith(".js"));
      const text = new Map(await Promise.all(chunks.map(async (name) => [name, await readFile(join(assets, name), "utf8")] as const)));
      const entry = /src="\/assets\/([^"]+\.js)"/.exec(await readFile(join(out, "index.html"), "utf8"))?.[1];

      expect(entry && text.has(entry)).toBe(true);
      expect(chunks.filter((name) => text.get(name)!.includes(MOCK_MARKER))).toEqual([]);
      expect(text.get(entry!)).not.toContain(FIXTURE_MARKER);
      const withFixtures = chunks.filter((name) => text.get(name)!.includes(FIXTURE_MARKER));
      expect(withFixtures).toHaveLength(1);
      expect(withFixtures[0]).toMatch(/^Simulation-/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
