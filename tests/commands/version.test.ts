import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

it("latch --version reports package.json's version, so packaged builds report theirs", () => {
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
  expect(execFileSync(process.execPath, ["--import", tsx, cli, "--version"], { encoding: "utf8" }).trim()).toBe(version);
});
