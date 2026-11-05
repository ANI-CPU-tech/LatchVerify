import { describe, expect, it } from "vitest";
import { isTransientDownloadError, withDownloadRetries } from "../../packaging/build-desktop.js";

describe("build-desktop's Electron download", () => {
  it("tells a flaky download from a real failure", () => {
    expect(isTransientDownloadError(new Error("Response code 504 (Gateway Time-out) for https://github.com/electron/electron/releases/download/v44.7.2/SHASUMS256.txt"))).toBe(true);
    expect(isTransientDownloadError(Object.assign(new Error("connect"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientDownloadError(new Error("Response code 404 (Not Found)"))).toBe(false);
    expect(isTransientDownloadError(new Error("electron packager built nothing"))).toBe(false);
  });

  it("retries transient failures only, then gives up", async () => {
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(new Error("Response code 504")) : Promise.resolve("ok"));
    expect(await withDownloadRetries(flaky, [0, 0], () => undefined)).toBe("ok");
    expect(calls).toBe(3);

    calls = 0;
    await expect(withDownloadRetries(() => (calls++, Promise.reject(new Error("Response code 503"))), [0], () => undefined)).rejects.toThrow("503");
    expect(calls).toBe(2);

    calls = 0;
    await expect(withDownloadRetries(() => (calls++, Promise.reject(new Error("Response code 404"))), [0, 0], () => undefined)).rejects.toThrow("404");
    expect(calls).toBe(1);
  });
});
