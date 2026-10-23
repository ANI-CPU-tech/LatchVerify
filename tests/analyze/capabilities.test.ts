import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PARAM_SIGNALS,
  anchoredPrefix,
  deriveFromSchema,
  emptyCapabilitySet,
  isEnvMatch,
  matchParamSignals,
  type SchemaSignal,
} from "../../src/analyze/capabilities.js";
import { CapabilitySetSchema, McpToolListSchema, type CapabilitySet, type McpTool } from "../../src/schema/index.js";

const fixtureTools = (name: string): McpTool[] =>
  McpToolListSchema.parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))).tools;

const fixtureTool = (file: string, name: string): McpTool => fixtureTools(file).find((t) => t.name === name)!;

/** A tool whose inputSchema has the given properties (and optional extra schema keywords). */
const toolWith = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}, meta: Partial<McpTool> = {}): McpTool => ({
  name: "probe",
  description: "Test tool.",
  ...meta,
  inputSchema: { type: "object", properties, ...extra },
});

const derive = (properties: Record<string, unknown>, extra?: Record<string, unknown>, meta?: Partial<McpTool>): CapabilitySet =>
  deriveFromSchema(toolWith(properties, extra, meta));

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

describe("deriveFromSchema", () => {
  describe("fixtures", () => {
    it("derives nothing from the benign weather tools' schemas", () => {
      for (const tool of fixtureTools("benign-tools.json")) expect(deriveFromSchema(tool)).toEqual(emptyCapabilitySet());
    });

    it("derives unconstrained filesystem read for poisoned read_config", () => {
      const caps = deriveFromSchema(fixtureTool("poisoned-tools.json", "read_config"));
      expect(caps.filesystem).toEqual({ read: true, write: false, scope: "unconstrained", paths: [] });
      expect(caps.exec.enabled).toBe(false);
    });

    it("derives shell exec for poisoned run_diagnostics", () => {
      expect(deriveFromSchema(fixtureTool("poisoned-tools.json", "run_diagnostics")).exec).toEqual({ enabled: true, shell: true });
    });

    it("derives unconstrained network egress for poisoned sync_alerts", () => {
      expect(deriveFromSchema(fixtureTool("poisoned-tools.json", "sync_alerts")).network).toEqual({
        egress: true,
        domains: [],
        unconstrained: true,
      });
    });

    it("always returns a valid CapabilitySet with no claims or cross-server refs", () => {
      for (const tool of [...fixtureTools("benign-tools.json"), ...fixtureTools("poisoned-tools.json")]) {
        const caps = deriveFromSchema(tool);
        expect(CapabilitySetSchema.parse(caps)).toEqual(caps);
        expect(caps.declared).toEqual({});
        expect(caps.crossServerRefs).toEqual([]);
      }
    });
  });

  describe("filesystem", () => {
    it("treats a bare string path as unconstrained read", () => {
      expect(derive({ path: { type: "string" } }).filesystem).toEqual({ read: true, write: false, scope: "unconstrained", paths: [] });
    });

    it("treats enum and const paths as constrained and lists them sorted", () => {
      expect(derive({ file: { type: "string", enum: ["/b.txt", "/a.txt", 3] } }).filesystem).toEqual({
        read: true,
        write: false,
        scope: "constrained",
        paths: ["/a.txt", "/b.txt"],
      });
      expect(derive({ file: { const: "/etc/app.conf" } }).filesystem.paths).toEqual(["/etc/app.conf"]);
    });

    it("turns anchored patterns into path globs, or exact paths", () => {
      expect(derive({ dir: { type: "string", pattern: "^/data/.*" } }).filesystem).toMatchObject({ scope: "constrained", paths: ["/data/*"] });
      expect(derive({ dir: { type: "string", pattern: "^/etc/app\\.conf$" } }).filesystem.paths).toEqual(["/etc/app.conf"]);
    });

    it("does not count a root-only or unanchored pattern as a constraint", () => {
      for (const pattern of ["^/.*", "^~/", "^C:\\\\", "^\\./", ".*\\.txt$"]) {
        expect(derive({ path: { type: "string", pattern } }).filesystem.scope).toBe("unconstrained");
      }
    });

    it("is unconstrained, with no path list, when any path parameter is unconstrained", () => {
      const caps = derive({ src: { type: "string", enum: ["/a"] }, dest_path: { type: "string" }, file: { enum: ["/b"] } });
      expect(caps.filesystem).toMatchObject({ scope: "unconstrained", paths: [] });
    });

    it("ignores path-named parameters that cannot hold a string", () => {
      expect(derive({ path: { type: "integer" }, file: { type: "boolean" }, dir: { enum: [1, 2] } })).toEqual(emptyCapabilitySet());
    });

    it("finds paths inside nested objects and arrays of objects", () => {
      expect(derive({ options: { type: "object", properties: { targetDir: { type: "string" } } } }).filesystem.read).toBe(true);
      expect(
        derive({ jobs: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } } }).filesystem.read,
      ).toBe(true);
    });

    it("reads an array of path strings as filesystem access", () => {
      expect(derive({ paths: { type: "array", items: { type: "string" } } }).filesystem.scope).toBe("unconstrained");
      expect(derive({ paths: { type: "array", items: { type: "string", enum: ["/a"] } } }).filesystem.scope).toBe("constrained");
    });

    it("sets write only when the tool's name or description uses a write verb", () => {
      expect(derive({ path: { type: "string" } }, {}, { name: "write_file" }).filesystem.write).toBe(true);
      expect(derive({ path: { type: "string" } }, {}, { name: "export", description: "Saves the report." }).filesystem.write).toBe(true);
      expect(derive({ path: { type: "string" } }, {}, { name: "cleanup", description: "Deletes temp files." }).filesystem.write).toBe(true);
      expect(derive({ path: { type: "string" } }, {}, { name: "read_file", description: "Reads a file." }).filesystem.write).toBe(false);
      expect(derive({ query: { type: "string" } }, {}, { name: "write_note" }).filesystem.write).toBe(false);
    });
  });

  describe("exec", () => {
    it("treats a free-form command string as shell exec", () => {
      expect(derive({ command: { type: "string" } }).exec).toEqual({ enabled: true, shell: true });
    });

    it("treats an argv array as exec without a shell", () => {
      expect(derive({ args: { type: "array", items: { type: "string" } } }).exec).toEqual({ enabled: true, shell: false });
    });

    it("treats a fixed set of commands as exec without a shell", () => {
      expect(derive({ cmd: { type: "string", enum: ["uptime", "df -h"] } }).exec).toEqual({ enabled: true, shell: false });
    });

    it("uses the widest branch of a union", () => {
      const command = { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] };
      expect(derive({ command }).exec).toEqual({ enabled: true, shell: true });
    });
  });

  describe("network", () => {
    it("treats a free-form URL as unconstrained egress", () => {
      expect(derive({ url: { type: "string" } }).network).toEqual({ egress: true, domains: [], unconstrained: true });
    });

    it("lists lowercase hosts from enum URLs and bare hosts", () => {
      const caps = derive({
        url: { type: "string", enum: ["https://api.weather.gov/points", "https://API.weather.gov/x", "http://example.com:8080/"] },
        host: { enum: ["internal.corp.net:443", "localhost"] },
      });
      expect(caps.network).toEqual({
        egress: true,
        domains: ["api.weather.gov", "example.com", "internal.corp.net", "localhost"],
        unconstrained: false,
      });
    });

    it("treats enum values that are not hosts as constrained with no domain", () => {
      expect(derive({ endpoint: { enum: ["primary", "secondary"] } }).network).toEqual({ egress: true, domains: [], unconstrained: false });
    });

    it("pins a host from a pattern only when a delimiter ends the host", () => {
      expect(derive({ url: { type: "string", pattern: "^https://api\\.x\\.com/" } }).network).toEqual({
        egress: true,
        domains: ["api.x.com"],
        unconstrained: false,
      });
      // Without the trailing slash, https://api.x.com.evil.net also matches.
      expect(derive({ url: { type: "string", pattern: "^https://api\\.x\\.com" } }).network.unconstrained).toBe(true);
    });

    it("reads the real host behind userinfo tricks", () => {
      expect(derive({ url: { type: "string", pattern: "^https://api\\.x\\.com@evil\\.net/" } }).network.domains).toEqual(["evil.net"]);
    });

    it("treats URL and hostname formats as egress whatever the parameter is called", () => {
      expect(derive({ target: { type: "string", format: "uri" } }).network.unconstrained).toBe(true);
      expect(derive({ server: { type: "string", format: "hostname" } }).network.egress).toBe(true);
      expect(derive({ when: { type: "string", format: "date-time" } })).toEqual(emptyCapabilitySet());
    });
  });

  describe("credentials", () => {
    it("flags secret-bearing parameters whatever their type or constraints", () => {
      expect(derive({ token: { type: "string" } }).credentials).toEqual({ readsEnv: false, readsSecrets: true });
      expect(derive({ apiKey: { type: "string", enum: ["k1"] } }).credentials.readsSecrets).toBe(true);
      expect(derive({ auth: { type: "object", properties: { password: { type: "number" } } } }).credentials.readsSecrets).toBe(true);
    });

    it("flags environment parameters as reading env", () => {
      expect(derive({ env: { type: "object", additionalProperties: { type: "string" } } }).credentials).toEqual({
        readsEnv: true,
        readsSecrets: false,
      });
    });

    it("ignores pagination tokens", () => {
      expect(derive({ pageToken: { type: "string" }, nextToken: { type: "string" } })).toEqual(emptyCapabilitySet());
    });
  });

  describe("schema structure", () => {
    it("treats an untyped parameter as accepting anything", () => {
      expect(derive({ path: {} }).filesystem.scope).toBe("unconstrained");
      expect(derive({ path: true }).filesystem.scope).toBe("unconstrained");
      expect(derive({ path: false })).toEqual(emptyCapabilitySet());
    });

    it("keeps an untyped enum constrained", () => {
      expect(derive({ path: { enum: ["/a"] } }).filesystem).toMatchObject({ scope: "constrained", paths: ["/a"] });
    });

    it("accepts type arrays that include string", () => {
      expect(derive({ path: { type: ["null", "string"] } }).filesystem.scope).toBe("unconstrained");
    });

    it("resolves local $refs, including JSON Pointer escapes", () => {
      const defs = { $defs: { "a/b": { type: "string" }, fixed: { enum: ["/srv"] } } };
      expect(derive({ path: { $ref: "#/$defs/a~1b" } }, defs).filesystem.scope).toBe("unconstrained");
      expect(derive({ path: { $ref: "#/$defs/fixed" } }, defs).filesystem.scope).toBe("constrained");
      expect(derive({ opts: { $ref: "#/$defs/opts" } }, { $defs: { opts: { properties: { command: { type: "string" } } } } }).exec.enabled).toBe(
        true,
      );
    });

    it("treats unresolvable or remote $refs as accepting anything", () => {
      expect(derive({ path: { $ref: "https://example.com/schema.json" } }).filesystem.scope).toBe("unconstrained");
      expect(derive({ path: { $ref: "#/$defs/missing" } }).filesystem.scope).toBe("unconstrained");
      expect(derive({ path: { $ref: "#/$defs/%E0%A4%A" } }).filesystem.scope).toBe("unconstrained");
    });

    it("never resolves a $ref to an inherited Object.prototype member", () => {
      expect(derive({ path: { $ref: "#/$defs/constructor" } }, { $defs: {} }).filesystem.scope).toBe("unconstrained");
    });

    it("ignores definitions nothing references", () => {
      expect(derive({ q: { type: "string" } }, { $defs: { unused: { properties: { command: { type: "string" } } } } })).toEqual(
        emptyCapabilitySet(),
      );
    });

    it("terminates on recursive schemas", () => {
      const tree = { node: { $ref: "#/$defs/node" } };
      const defs = { $defs: { node: { type: "object", properties: { file: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } } };
      expect(derive(tree, defs).filesystem.read).toBe(true);
      expect(derive({ loop: { $ref: "#" } }).filesystem.read).toBe(false);
    });

    it("rejects $ref chains that expand exponentially", () => {
      const defs: Record<string, unknown> = { d40: { type: "string" } };
      for (let i = 0; i < 40; i++) defs[`d${i}`] = { anyOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
      expect(() => derive({ path: { $ref: "#/$defs/d0" } }, { $defs: defs })).toThrow(RangeError);
    });

    it("rejects absurdly deep nesting", () => {
      let schema: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 300; i++) schema = { type: "object", properties: { inner: schema } };
      expect(() => derive({ outer: schema })).toThrow(RangeError);
    });

    it("finds properties under if/then/else and dependentSchemas", () => {
      expect(derive({}, { if: { required: ["x"] }, then: { properties: { url: { type: "string" } } } }).network.egress).toBe(true);
      expect(derive({}, { dependentSchemas: { x: { properties: { cmd: { type: "string" } } } } }).exec.enabled).toBe(true);
    });
  });

  describe("determinism", () => {
    it("does not depend on key order", () => {
      const forward = derive({ url: { enum: ["https://b.com/", "https://a.com/"] }, file: { enum: ["/z", "/y"] } });
      const reversed = derive({ file: { enum: ["/y", "/z"] }, url: { enum: ["https://a.com/", "https://b.com/"] } });
      expect(reversed).toEqual(forward);
      expect(forward.network.domains).toEqual(["a.com", "b.com"]);
    });

    it("does not mutate the tool", () => {
      const tool = Object.freeze(structuredClone(fixtureTool("poisoned-tools.json", "read_config")));
      const before = structuredClone(tool);
      deriveFromSchema(tool);
      expect(tool).toEqual(before);
    });
  });
});
