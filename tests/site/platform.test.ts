import { describe, expect, it } from "vitest";
import { detectPlatform, suggestedPackage } from "../../site/src/lib/platform.js";
import { THEME_STORAGE_KEY, parseTheme, readTheme, resolveTheme, writeTheme } from "../../site/src/lib/theme.js";

const UA = {
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ubuntuFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("detectPlatform", () => {
  it("reads the user agent", () => {
    expect(detectPlatform(UA.windowsChrome)).toBe("windows");
    expect(detectPlatform(UA.macSafari)).toBe("mac");
    expect(detectPlatform(UA.linuxChrome)).toBe("linux");
    expect(detectPlatform(UA.ubuntuFirefox)).toBe("linux");
    expect(detectPlatform(UA.chromebook)).toBe("other");
    expect(detectPlatform("")).toBe("other");
  });

  it("counts Android as a phone, not as Linux, and so the iPhone", () => {
    expect(detectPlatform(UA.android)).toBe("mobile");
    expect(detectPlatform(UA.iphone)).toBe("mobile");
  });

  it("prefers the client hint where the browser gives one", () => {
    expect(detectPlatform(UA.linuxChrome, "Windows")).toBe("windows");
    expect(detectPlatform(UA.linuxChrome, "macOS")).toBe("mac");
    expect(detectPlatform(UA.windowsChrome, "Linux")).toBe("linux");
    expect(detectPlatform(UA.linuxChrome, "Android")).toBe("mobile");
    expect(detectPlatform(UA.windowsChrome, "")).toBe("windows");
  });
});

describe("suggestedPackage", () => {
  it("suggests the setup EXE on Windows and nothing on a Mac or a phone", () => {
    expect(suggestedPackage("windows", UA.windowsChrome)).toBe("windows");
    expect(suggestedPackage("mac", UA.macSafari)).toBeNull();
    expect(suggestedPackage("mobile", UA.android)).toBeNull();
  });

  it("names a Linux package only when the user agent names the distribution", () => {
    expect(suggestedPackage("linux", UA.ubuntuFirefox)).toBe("deb");
    expect(suggestedPackage("linux", "Mozilla/5.0 (X11; Linux x86_64; Manjaro) Firefox/132.0")).toBe("arch");
    expect(suggestedPackage("linux", UA.linuxChrome)).toBeNull();
  });
});

describe("theme preference", () => {
  it("follows the system until the visitor chooses", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads only the two themes, and survives storage that throws", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("terminal")).toBeNull();
    expect(readTheme({ getItem: (key) => (key === THEME_STORAGE_KEY ? "light" : null) })).toBe("light");
    expect(
      readTheme({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBeNull();
    expect(readTheme(undefined)).toBeNull();
  });

  it("reports whether a choice was saved", () => {
    const saved = new Map<string, string>();
    expect(writeTheme({ setItem: (key, value) => void saved.set(key, value) }, "dark")).toBe(true);
    expect(saved.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(
      writeTheme(
        {
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        },
        "dark",
      ),
    ).toBe(false);
    expect(writeTheme(undefined, "light")).toBe(false);
  });
});
