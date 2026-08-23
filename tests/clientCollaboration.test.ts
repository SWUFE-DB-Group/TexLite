import { describe, expect, it } from "vitest";
import { writableDraftAvailability, writableDraftCoveredByFlush } from "../src/client/collaboration";

describe("client collaboration draft generations", () => {
  it("clears a marker only when the flush covers every current local edit", () => {
    expect(writableDraftCoveredByFlush(3, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(2, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(4, 4, 3)).toBe(false);
    expect(writableDraftCoveredByFlush(3, 4, 3)).toBe(false);
  });

  it("distinguishes live tabs from recoverable inactive drafts", () => {
    const now = 1_000_000;
    expect(writableDraftAvailability([
      { tabId: "current", activeAt: now }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: now }
    ], "current", now)).toEqual({ recoverable: false, otherActive: true });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: 0 }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: 1 }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
  });

  it("keeps recovery available while another live tab temporarily blocks deletion", () => {
    const now = 200_000;
    expect(writableDraftAvailability([
      { tabId: "current", activeAt: now },
      { tabId: "other", activeAt: now }
    ], "current", now)).toEqual({ recoverable: true, otherActive: true });
  });
});
