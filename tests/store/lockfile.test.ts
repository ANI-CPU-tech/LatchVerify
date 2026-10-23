import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LockfileError,
  emptyLockfile,
  findRecord,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from "../../src/store/lockfile.js";
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

/** Same value with every object's keys in reverse insertion order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}

/** The example lockfile with a second server, for ordering tests. */
const twoServers = async (): Promise<LockFile> => {
  const lock = await loadExample();
  const mail = structuredClone(lock.servers.weather!);
  mail.command = "mail-server";
  mail.tools = mail.tools.map((t) => ({ ...t, serverId: "mail" }));
  lock.servers = { weather: lock.servers.weather!, mail };
  return lock;
};

describe("writeLockfile", () => {
  it("round-trips latch.lock.example byte for byte", async () => {
    const out = join(dir, "latch.lock");
    await writeLockfile(out, await readLockfile(EXAMPLE_PATH.pathname));
    expect(await readFile(out, "utf8")).toBe(await readFile(EXAMPLE_PATH, "utf8"));
  });

  it("writes 2-space JSON with a trailing newline that reads back equal", async () => {
    const out = join(dir, "latch.lock");
    const lock = await loadExample();
    await writeLockfile(out, lock);
    const text = await readFile(out, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")[1]).toBe('  "version": "1",');
    expect(await readLockfile(out)).toEqual(lock);
  });

  it("writes the same bytes whatever the server, tool or key order", async () => {
    const lock = await twoServers();
    const shuffled = reverseKeys(lock) as LockFile;
    for (const server of Object.values(shuffled.servers)) server.tools.reverse();
    await writeLockfile(join(dir, "a.lock"), lock);
    await writeLockfile(join(dir, "b.lock"), shuffled);
    const a = await readFile(join(dir, "a.lock"), "utf8");
    expect(await readFile(join(dir, "b.lock"), "utf8")).toBe(a);
    expect(Object.keys(JSON.parse(a).servers)).toEqual(["mail", "weather"]);
  });

  it("matches serializeLockfile exactly", async () => {
    const out = join(dir, "latch.lock");
    const lock = await twoServers();
    await writeLockfile(out, lock);
    expect(await readFile(out, "utf8")).toBe(serializeLockfile(LockFileSchema.parse(lock)));
  });

  it("creates missing parent directories", async () => {
    const out = join(dir, "nested", "deeper", "latch.lock");
    await writeLockfile(out, emptyLockfile());
    expect(await readLockfile(out)).toEqual(emptyLockfile());
  });

  it("refuses to write an invalid lockfile and leaves the existing file untouched", async () => {
    const out = join(dir, "latch.lock");
    await writeLockfile(out, await loadExample());
    const before = await readFile(out, "utf8");
    const bad = await loadExample();
    bad.servers.weather!.tools[0]!.serverId = "elsewhere";
    expect((await rejection(writeLockfile(out, bad))).message).toContain("invalid lockfile");
    expect((await rejection(writeLockfile(out, { ...emptyLockfile(), version: "2" }))).message).toContain("unsupported lockfile version");
    expect(await readFile(out, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["latch.lock"]);
  });

  it("replaces an existing file and leaves no temporary files behind", async () => {
    const out = join(dir, "latch.lock");
    await writeLockfile(out, emptyLockfile());
    await writeLockfile(out, await loadExample());
    expect(await readLockfile(out)).toEqual(await loadExample());
    expect(await readdir(dir)).toEqual(["latch.lock"]);
  });

  it("reports a failed write and cleans up its temporary file", async () => {
    const out = join(dir, "latch.lock");
    await mkdir(join(out, "occupied"), { recursive: true }); // a non-empty directory cannot be replaced by a file
    const error = await rejection(writeLockfile(out, emptyLockfile()));
    expect(error.message).toContain("cannot write lockfile");
    expect(await readdir(dir)).toEqual(["latch.lock"]);
  });

  it("never leaves a torn file when writes race", async () => {
    const out = join(dir, "latch.lock");
    const versions = Array.from({ length: 20 }, (_, i) => ({ ...emptyLockfile(), generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    await Promise.all(versions.map((lock) => writeLockfile(out, lock)));
    const final = await readLockfile(out);
    expect(versions).toContainEqual(final);
    expect(await readdir(dir)).toEqual(["latch.lock"]);
  });
});

describe("findRecord", () => {
  it("returns the pinned record for a server and tool", async () => {
    const lock = await loadExample();
    expect(findRecord(lock, "weather", "get_forecast")).toBe(lock.servers.weather!.tools.find((t) => t.name === "get_forecast"));
  });

  it("returns undefined for an unpinned tool or an unknown server", async () => {
    const lock = await loadExample();
    expect(findRecord(lock, "weather", "read_config")).toBeUndefined();
    expect(findRecord(lock, "mail", "get_forecast")).toBeUndefined();
    expect(findRecord(emptyLockfile(), "weather", "get_forecast")).toBeUndefined();
  });

  it("never resolves server ids to Object.prototype members", async () => {
    const lock = await loadExample();
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(findRecord(lock, id, "get_forecast")).toBeUndefined();
    }
  });

  it("matches tool names exactly", async () => {
    const lock = await loadExample();
    expect(findRecord(lock, "weather", "GET_FORECAST")).toBeUndefined();
    expect(findRecord(lock, "weather", "get_forecast ")).toBeUndefined();
  });
});
