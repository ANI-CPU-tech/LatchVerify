import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockfileError, emptyLockfile, readLockfile } from "../../src/store/lockfile.js";
import { LOCKFILE_VERSION, LockFileSchema, type LockFile } from "../../src/schema/index.js";

const EXAMPLE_PATH = new URL("../../latch.lock.example", import.meta.url);

const loadExample = async (): Promise<LockFile> => LockFileSchema.parse(JSON.parse(await readFile(EXAMPLE_PATH, "utf8")));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-lockfile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `content` to a file in the temp dir and returns its path. */
const fixtureFile = async (name: string, content: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
};

/** The LockfileError a promise rejects with. */
const rejection = async (promise: Promise<unknown>): Promise<LockfileError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LockfileError);
  return error as LockfileError;
};

describe("emptyLockfile", () => {
  it("is the current format with no servers", () => {
    expect(emptyLockfile()).toEqual({ version: LOCKFILE_VERSION, generatedAt: "1970-01-01T00:00:00.000Z", servers: {} });
    expect(LockFileSchema.parse(emptyLockfile())).toEqual(emptyLockfile());
  });

  it("returns a fresh object every call", () => {
    const first = emptyLockfile();
    first.servers.x = { transport: "stdio", command: "x", args: [], tools: [] };
    expect(emptyLockfile().servers).toEqual({});
  });
});

describe("readLockfile", () => {
  it("reads and validates latch.lock.example", async () => {
    const lock = await readLockfile(EXAMPLE_PATH.pathname);
    expect(lock).toEqual(await loadExample());
    expect(lock.servers.weather?.tools.map((t) => t.name)).toEqual(["get_alerts", "get_forecast"]);
  });

  it("returns an empty lockfile when the file does not exist", async () => {
    expect(await readLockfile(join(dir, "missing.lock"))).toEqual({ version: "1", generatedAt: "1970-01-01T00:00:00.000Z", servers: {} });
  });

  it("ignores a leading byte-order mark", async () => {
    const example = await readFile(EXAMPLE_PATH, "utf8");
    expect(await readLockfile(await fixtureFile("bom.lock", `\u{feff}${example}`))).toEqual(await loadExample());
  });

  it("rejects invalid JSON, naming the file", async () => {
    const path = await fixtureFile("broken.lock", '{ "version": "1", ');
    const error = await rejection(readLockfile(path));
    expect(error.path).toBe(path);
    expect(error.name).toBe("LockfileError");
    expect(error.message.startsWith(`${path}: not valid JSON`)).toBe(true);
  });

  it("rejects an empty file instead of treating it as empty", async () => {
    expect((await rejection(readLockfile(await fixtureFile("empty.lock", "")))).message).toContain("not valid JSON");
  });

  it("lists schema violations with their field paths", async () => {
    const lock = await loadExample();
    lock.servers.weather!.tools[0]!.hashes.name = "not-a-hash";
    lock.generatedAt = "yesterday";
    const error = await rejection(readLockfile(await fixtureFile("invalid.lock", JSON.stringify(lock))));
    expect(error.message).toContain("invalid lockfile");
    expect(error.message).toContain("servers.weather.tools[0].hashes.name");
    expect(error.message).toContain("generatedAt");
  });

  it("enforces the schema's cross-field rules", async () => {
    const lock = await loadExample();
    lock.servers.weather!.tools[1]!.name = "get_alerts";
    expect((await rejection(readLockfile(await fixtureFile("dupe.lock", JSON.stringify(lock))))).message).toContain('duplicate tool "get_alerts"');
  });

  it("refuses a lockfile version it does not understand", async () => {
    const lock = { ...(await loadExample()), version: "2" };
    expect((await rejection(readLockfile(await fixtureFile("future.lock", JSON.stringify(lock))))).message).toContain(
      'unsupported lockfile version "2"',
    );
  });

  it("reports unreadable paths, such as a directory, instead of returning an empty lockfile", async () => {
    const error = await rejection(readLockfile(dir));
    expect(error.message).toContain("cannot read lockfile");
    expect(error.cause).toBeDefined();
  });
});
