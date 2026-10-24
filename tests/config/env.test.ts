import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "../../src/analyze/llm.js";
import { LOG_LEVELS, loadDotEnv, loadEnv, statePaths } from "../../src/config/env.js";

const defaults = {
  llmApiKey: undefined,
  llmEnabled: false,
  llmBaseUrl: DEFAULT_LLM_BASE_URL,
  llmModel: DEFAULT_LLM_MODEL,
  uiPort: 7777,
  lockfilePath: resolve("latch.lock"),
  stateDir: resolve(".latch"),
  logLevel: "info",
};

/** The error loadEnv throws for `env`. */
const failure = (env: NodeJS.ProcessEnv): string => {
  try {
    loadEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("loadEnv did not throw");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadEnv", () => {
  it("uses the .env.example defaults for an empty environment", () => {
    expect(loadEnv({})).toEqual(defaults);
  });

  it("treats the blank values in .env.example as unset", () => {
    expect(
      loadEnv({
        LATCH_LLM_API_KEY: "",
        LATCH_LLM_ENABLED: "false",
        LATCH_UI_PORT: "7777",
        LATCH_LOCKFILE_PATH: "./latch.lock",
        LATCH_STATE_DIR: "./.latch",
        LATCH_LOG_LEVEL: "info",
      }),
    ).toEqual(defaults);
    expect(loadEnv({ LATCH_LLM_API_KEY: "   ", LATCH_UI_PORT: " ", LATCH_LOG_LEVEL: "" })).toEqual(defaults);
  });

  it("reads every variable, trimming whitespace", () => {
    expect(
      loadEnv({
        LATCH_LLM_API_KEY: " sk-ant-test ",
        LATCH_LLM_ENABLED: "TRUE",
        LATCH_LLM_BASE_URL: " https://openrouter.ai/api/v1 ",
        LATCH_LLM_MODEL: "some/model",
        LATCH_UI_PORT: " 8080 ",
        LATCH_LOCKFILE_PATH: "/srv/repo/latch.lock",
        LATCH_STATE_DIR: "state",
        LATCH_LOG_LEVEL: "Debug",
      }),
    ).toEqual({
      llmApiKey: "sk-ant-test",
      llmEnabled: true,
      llmBaseUrl: "https://openrouter.ai/api/v1",
      llmModel: "some/model",
      uiPort: 8080,
      lockfilePath: "/srv/repo/latch.lock",
      stateDir: resolve("state"),
      logLevel: "debug",
    });
  });

  it("resolves relative paths against the working directory", () => {
    const env = loadEnv({ LATCH_LOCKFILE_PATH: "../x/latch.lock", LATCH_STATE_DIR: "a/../b" });
    expect(env.lockfilePath).toBe(resolve(process.cwd(), "../x/latch.lock"));
    expect(env.stateDir).toBe(resolve(process.cwd(), "b"));
  });

  it("accepts every boolean spelling for LATCH_LLM_ENABLED", () => {
    for (const value of ["true", "1", "yes", "on", "ON"]) {
      expect(loadEnv({ LATCH_LLM_ENABLED: value, LATCH_LLM_API_KEY: "k" }).llmEnabled, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", "False"]) {
      expect(loadEnv({ LATCH_LLM_ENABLED: value }).llmEnabled, value).toBe(false);
    }
  });

  it("accepts every log level, in any case", () => {
    for (const level of LOG_LEVELS) {
      expect(loadEnv({ LATCH_LOG_LEVEL: level.toUpperCase() }).logLevel).toBe(level);
    }
  });

  it("accepts the port limits", () => {
    expect(loadEnv({ LATCH_UI_PORT: "1" }).uiPort).toBe(1);
    expect(loadEnv({ LATCH_UI_PORT: "65535" }).uiPort).toBe(65535);
    expect(loadEnv({ LATCH_UI_PORT: "08080" }).uiPort).toBe(8080);
  });

  it("names LATCH_UI_PORT when the port is malformed or out of range", () => {
    for (const port of ["abc", "0", "65536", "-1", "80.5", "1e3", "0x50", "80 80", "123456"]) {
      expect(failure({ LATCH_UI_PORT: port }), port).toContain(
        `LATCH_UI_PORT must be a port number from 1 to 65535, got ${JSON.stringify(port)}`,
      );
    }
  });

  it("names LATCH_LOG_LEVEL and the allowed levels for an unknown level", () => {
    expect(failure({ LATCH_LOG_LEVEL: "verbose" })).toContain(
      'LATCH_LOG_LEVEL must be one of debug, info, warn, error, got "verbose"',
    );
  });

  it("rejects an unrecognized boolean", () => {
    expect(failure({ LATCH_LLM_ENABLED: "maybe" })).toContain('LATCH_LLM_ENABLED must be true or false, got "maybe"');
  });

  it("refuses the LLM pass without an API key", () => {
    expect(failure({ LATCH_LLM_ENABLED: "true" })).toContain("LATCH_LLM_ENABLED is true but LATCH_LLM_API_KEY is not set");
    expect(failure({ LATCH_LLM_ENABLED: "true", LATCH_LLM_API_KEY: "  " })).toContain("LATCH_LLM_API_KEY is not set");
  });

  it("lists every problem in one error", () => {
    const message = failure({ LATCH_UI_PORT: "abc", LATCH_LOG_LEVEL: "loud", LATCH_LLM_ENABLED: "yes" });
    expect(message.split("\n")).toEqual([
      "Invalid LatchVerify environment:",
      "  - LATCH_LLM_ENABLED is true but LATCH_LLM_API_KEY is not set",
      '  - LATCH_UI_PORT must be a port number from 1 to 65535, got "abc"',
      '  - LATCH_LOG_LEVEL must be one of debug, info, warn, error, got "loud"',
    ]);
  });

  it("never puts the API key in an error message", () => {
    expect(failure({ LATCH_LLM_API_KEY: "sk-ant-secret", LATCH_UI_PORT: "x" })).not.toContain("sk-ant-secret");
  });

  it("reads process.env by default", () => {
    vi.stubEnv("LATCH_UI_PORT", "9123");
    vi.stubEnv("LATCH_LOG_LEVEL", "warn");
    expect(loadEnv()).toMatchObject({ uiPort: 9123, logLevel: "warn" });
  });
});

describe("statePaths", () => {
  it("puts the state directory next to the lockfile by default, wherever the command runs", () => {
    expect(statePaths({})).toEqual({ lockfilePath: resolve("latch.lock"), stateDir: resolve(".latch") });
    expect(statePaths({ lockfile: "/srv/repo/latch.lock" })).toEqual({ lockfilePath: "/srv/repo/latch.lock", stateDir: "/srv/repo/.latch" });
    expect(statePaths({}, { LATCH_LOCKFILE_PATH: " /srv/repo/latch.lock " }).stateDir).toBe("/srv/repo/.latch");
    expect(loadEnv({ LATCH_LOCKFILE_PATH: "/srv/repo/latch.lock" }).stateDir).toBe("/srv/repo/.latch");
  });

  it("lets a flag win over the environment, and the environment over the default", () => {
    const env = { LATCH_LOCKFILE_PATH: "/env/latch.lock", LATCH_STATE_DIR: "/env/state" };
    expect(statePaths({}, env)).toEqual({ lockfilePath: "/env/latch.lock", stateDir: "/env/state" });
    expect(statePaths({ lockfile: "/flag/latch.lock", stateDir: "/flag/state" }, env)).toEqual({
      lockfilePath: "/flag/latch.lock",
      stateDir: "/flag/state",
    });
    expect(statePaths({ lockfile: "/flag/latch.lock" }, { LATCH_STATE_DIR: " " }).stateDir).toBe("/flag/.latch");
  });
});

describe("statePaths with a fallback lockfile", () => {
  const user = "/home/dev/.config/latchverify/latch.lock";
  const existing = (...paths: string[]) => (path: string) => paths.includes(path);

  it("uses the fallback when ./latch.lock is missing and the fallback exists", () => {
    expect(statePaths({}, {}, { fallbackLockfile: user, exists: existing(user) })).toEqual({
      lockfilePath: user,
      stateDir: "/home/dev/.config/latchverify/.latch",
    });
  });

  it("keeps ./latch.lock when it exists, and when the fallback does not", () => {
    expect(statePaths({}, {}, { fallbackLockfile: user, exists: existing(resolve("latch.lock"), user) }).lockfilePath).toBe(resolve("latch.lock"));
    expect(statePaths({}, {}, { fallbackLockfile: user, exists: existing() }).lockfilePath).toBe(resolve("latch.lock"));
  });

  it("never overrides a flag or the environment", () => {
    const opts = { fallbackLockfile: user, exists: existing(user) };
    expect(statePaths({ lockfile: "/flag/latch.lock" }, {}, opts).lockfilePath).toBe("/flag/latch.lock");
    expect(statePaths({}, { LATCH_LOCKFILE_PATH: "/env/latch.lock" }, opts).lockfilePath).toBe("/env/latch.lock");
  });
});

describe("loadDotEnv", () => {
  it("loads a .env file into process.env without overriding variables already set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latch-env-"));
    try {
      const path = join(dir, ".env");
      await writeFile(path, "LATCH_UI_PORT=9001\nLATCH_LOG_LEVEL=debug\n");
      vi.stubEnv("LATCH_UI_PORT", undefined);
      vi.stubEnv("LATCH_LOG_LEVEL", "error");
      loadDotEnv(path);
      expect(loadEnv()).toMatchObject({ uiPort: 9001, logLevel: "error" });
      expect(() => loadDotEnv(join(dir, "missing.env"))).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
