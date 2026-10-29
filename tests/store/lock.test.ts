import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../../src/store/lock.js";

let dir: string;
let lock: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "latch-lock-"));
  lock = join(dir, "state.lock");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("runs tasks one at a time and removes the lock afterwards", async () => {
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(`${name} start`);
      await sleep(30);
      order.push(`${name} end`);
      return name;
    };
    expect(await Promise.all([withFileLock(lock, task("a")), withFileLock(lock, task("b"))])).toEqual(["a", "b"]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("releases the lock when the task throws", async () => {
    await expect(withFileLock(lock, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a slow holder's lock fresh, so a waiter never takes it over", async () => {
    const order: string[] = [];
    const slow = withFileLock(
      lock,
      async () => {
        order.push("slow start");
        await sleep(400);
        order.push("slow end");
      },
      { staleMs: 100 },
    );
    await sleep(20);
    await withFileLock(lock, async () => void order.push("waiter"), { staleMs: 100 });
    await slow;
    expect(order).toEqual(["slow start", "slow end", "waiter"]);
  });

  it("takes over a lock left behind by a crashed holder, including one with no token", async () => {
    for (const content of ["", "token-of-a-dead-process"]) {
      await writeFile(lock, content);
      const old = (Date.now() - 60_000) / 1000;
      await utimes(lock, old, old);
      expect(await withFileLock(lock, async () => "ran", { staleMs: 100 })).toBe("ran");
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it("does not remove a lock another holder took over meanwhile", async () => {
    await withFileLock(lock, async () => {
      await writeFile(lock, "someone-else");
    });
    expect(await readFile(lock, "utf8")).toBe("someone-else");
  });
});
