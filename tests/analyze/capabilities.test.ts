import { describe, expect, it } from "vitest";
import {
  PARAM_SIGNALS,
  anchoredPrefix,
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

describe("anchoredPrefix", () => {
  it("returns the literal text after ^ up to the first regex syntax", () => {
    expect(anchoredPrefix("^/data/.*")).toEqual({ prefix: "/data/", exact: false });
    expect(anchoredPrefix("^/srv/app/[a-z]+\\.log$")).toEqual({ prefix: "/srv/app/", exact: false });
    expect(anchoredPrefix("^https://api\\.weather\\.gov/")).toEqual({ prefix: "https://api.weather.gov/", exact: false });
  });

  it("marks a fully literal pattern ending in $ as exact", () => {
    expect(anchoredPrefix("^/etc/app\\.conf$")).toEqual({ prefix: "/etc/app.conf", exact: true });
  });

  it("unescapes escaped punctuation", () => {
    expect(anchoredPrefix("^C:\\\\Users\\\\")).toEqual({ prefix: "C:\\Users\\", exact: false });
    expect(anchoredPrefix("^\\/srv")).toEqual({ prefix: "/srv", exact: false });
    expect(anchoredPrefix("^a\\$b\\(c\\)")).toEqual({ prefix: "a$b(c)", exact: false });
  });

  it("drops a character made optional by ?, * or {", () => {
    expect(anchoredPrefix("^/tmps?/")).toEqual({ prefix: "/tmp", exact: false });
    expect(anchoredPrefix("^/a*")).toEqual({ prefix: "/", exact: false });
    expect(anchoredPrefix("^/ab{0,2}")).toEqual({ prefix: "/a", exact: false });
  });

  it("keeps a character repeated by + and stops after it", () => {
    expect(anchoredPrefix("^/a+/b")).toEqual({ prefix: "/a", exact: false });
  });

  it("returns null when nothing is provably fixed", () => {
    for (const pattern of ["", "^", "^$", ".*", "/data/.*", "^.*", "^[/]data", "^\\d+", "^\\u002Fdata", "^(/data)", "^/data/|.*", "^a?"]) {
      expect(anchoredPrefix(pattern)).toBeNull();
    }
  });

  it("treats any alternation as unconstrained, even inside a group", () => {
    expect(anchoredPrefix("^/data/(a|b)")).toBeNull();
  });

  it("handles characters outside the Basic Multilingual Plane as one unit", () => {
    expect(anchoredPrefix("^/\u{1f600}/x")).toEqual({ prefix: "/\u{1f600}/x", exact: false });
    expect(anchoredPrefix("^/\u{1f600}?")).toEqual({ prefix: "/", exact: false });
  });
});
