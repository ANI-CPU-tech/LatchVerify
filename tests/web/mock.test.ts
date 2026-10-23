import { describe, expect, it } from "vitest";
import { PendingChangeSchema } from "../../src/schema/index.js";
import { mockReviewItems } from "../../web/src/lib/mock.js";

describe("mockReviewItems", () => {
  it("are valid pending changes, so the sample screen shows data the API could really send", () => {
    expect(mockReviewItems.length).toBeGreaterThan(0);
    for (const { change } of mockReviewItems) expect(PendingChangeSchema.parse(change)).toEqual(change);
  });

  it("have unique ids", () => {
    const ids = mockReviewItems.map((item) => item.change.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
