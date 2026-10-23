import { describe, expect, it } from "vitest";
import {
  PARAM_SIGNALS,
  emptyCapabilitySet,
  isEnvMatch,
  matchParamSignals,
  type SchemaSignal,
} from "../../src/analyze/capabilities.js";
import { CapabilitySetSchema } from "../../src/schema/index.js";

const signals = (name: string): SchemaSignal[] => matchParamSignals(name).map((m) => m.signal);

describe("emptyCapabilitySet", () => {
  it("is a valid CapabilitySet with nothing enabled", () => {
    const empty = emptyCapabilitySet();
    expect(CapabilitySetSchema.parse(empty)).toEqual(empty);
    expect(empty).toEqual({
      filesystem: { read: false, write: false, scope: "none", paths: [] },
      exec: { enabled: false, shell: false },
      network: { egress: false, domains: [], unconstrained: false },
      credentials: { readsEnv: false, readsSecrets: false },
      crossServerRefs: [],
      declared: {},
    });
  });

  it("returns a fresh object every call", () => {
    const first = emptyCapabilitySet();
    first.filesystem.paths.push("/etc");
    first.declared.readOnlyHint = true;
    expect(emptyCapabilitySet().filesystem.paths).toEqual([]);
    expect(emptyCapabilitySet().declared).toEqual({});
  });
});

describe("matchParamSignals", () => {
  it("matches every word in the signal table to its own signal", () => {
    for (const [signal, names] of Object.entries(PARAM_SIGNALS)) {
      for (const name of names) expect(signals(name)).toEqual([signal]);
    }
  });

  it("is case-insensitive", () => {
    for (const name of ["PATH", "Path", "pAtH"]) expect(signals(name)).toEqual(["filesystem"]);
  });

  it("matches compounds in snake, kebab, camel and Pascal case", () => {
    expect(signals("file_path")).toEqual(["filesystem"]);
    expect(signals("filePath")).toEqual(["filesystem"]);
    expect(signals("file-name")).toEqual(["filesystem"]);
    expect(signals("targetDir")).toEqual(["filesystem"]);
    expect(signals("webhookURL")).toEqual(["network"]);
    expect(signals("HTTPEndpoint")).toEqual(["network"]);
    expect(signals("shellCommand")).toEqual(["exec"]);
    expect(signals("API_KEY")).toEqual(["credentials"]);
    expect(signals("apiKey")).toEqual(["credentials"]);
  });

  it("matches regular plurals", () => {
    expect(signals("paths")).toEqual(["filesystem"]);
    expect(signals("files")).toEqual(["filesystem"]);
    expect(signals("directories")).toEqual(["filesystem"]);
    expect(signals("urls")).toEqual(["network"]);
    expect(signals("commands")).toEqual(["exec"]);
    expect(signals("secrets")).toEqual(["credentials"]);
  });

  it("does not match table words embedded inside other words", () => {
    for (const name of ["profile", "filter", "hostile", "pathological", "urgent", "commander", "envelope", "latitude", "units", "state", "notes", ""]) {
      expect(signals(name)).toEqual([]);
    }
  });

  it("reports every signal a name carries, once each, in table order", () => {
    expect(signals("file_url")).toEqual(["filesystem", "network"]);
    expect(signals("path_or_paths")).toEqual(["filesystem"]);
    expect(matchParamSignals("scriptPath")).toEqual([
      { signal: "filesystem", word: "path" },
      { signal: "exec", word: "script" },
    ]);
  });

  it("does not treat pagination tokens as credentials", () => {
    for (const name of ["pageToken", "next_page_token", "nextToken", "continuationToken", "cursor_token"]) {
      expect(signals(name)).toEqual([]);
    }
    for (const name of ["token", "accessToken", "auth_token", "tokens"]) {
      expect(signals(name)).toEqual(["credentials"]);
    }
  });

  it("distinguishes environment variables from secret values", () => {
    expect(matchParamSignals("envVars").filter(isEnvMatch)).toHaveLength(1);
    expect(matchParamSignals("env").filter(isEnvMatch)).toHaveLength(1);
    expect(matchParamSignals("apiKey").filter(isEnvMatch)).toHaveLength(0);
    expect(matchParamSignals("path").filter(isEnvMatch)).toHaveLength(0);
  });

  it("sees through invisible characters and full-width letters", () => {
    expect(signals("pa\u200bth")).toEqual(["filesystem"]);
    expect(signals("com\u2060mand")).toEqual(["exec"]);
    expect(signals("\uff30\uff21\uff34\uff28")).toEqual(["filesystem"]); // full-width PATH
  });
});
