import { describe, expect, it } from "vitest";
import { globalTooltipPosition } from "../src/client/GlobalTooltip";

describe("global tooltip placement", () => {
  it("places ordinary controls above their anchor", () => {
    expect(globalTooltipPosition({ top: 240, bottom: 272, left: 100, width: 40 }, 1200))
      .toEqual({ placement: "above", top: 232, left: 160 });
  });

  it("falls back below controls too close to the viewport top", () => {
    expect(globalTooltipPosition({ top: 18, bottom: 42, left: 0, width: 24 }, 320))
      .toEqual({ placement: "below", top: 50, left: 152 });
  });
});
