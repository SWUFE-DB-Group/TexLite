import { describe, expect, it } from "vitest";
import { writableDraftCoveredByFlush } from "../src/client/collaboration";

describe("client collaboration draft generations", () => {
  it("clears a marker only when the flush covers every current local edit", () => {
    expect(writableDraftCoveredByFlush(3, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(2, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(4, 4, 3)).toBe(false);
    expect(writableDraftCoveredByFlush(3, 4, 3)).toBe(false);
  });
});
