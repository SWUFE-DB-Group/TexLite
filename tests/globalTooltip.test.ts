import { describe, expect, it } from "vitest";
import { globalTooltipPosition, tooltipIsDisabled } from "../src/client/GlobalTooltip";

describe("global tooltip placement", () => {
  it("places ordinary controls above their anchor", () => {
    expect(globalTooltipPosition({ top: 240, bottom: 272, left: 100, width: 40 }, 1200))
      .toEqual({ placement: "above", top: 232, left: 120 });
  });

  it("keeps the above placement for controls close to the viewport top", () => {
    expect(globalTooltipPosition({ top: 18, bottom: 42, left: 0, width: 24 }, 320))
      .toEqual({ placement: "above", top: 10, left: 12 });
  });

  it("centers a short tooltip above a button near the left edge", () => {
    expect(globalTooltipPosition({ top: 700, bottom: 734, left: 18, width: 92 }, 1200, 100))
      .toEqual({ placement: "above", top: 692, left: 64 });
  });

  it("uses the measured width to keep long tooltips inside either screen edge", () => {
    expect(globalTooltipPosition({ top: 700, bottom: 734, left: 18, width: 92 }, 1200, 320).left).toBe(168);
    expect(globalTooltipPosition({ top: 700, bottom: 734, left: 1140, width: 40 }, 1200, 160).left).toBe(1112);
    expect(globalTooltipPosition({ top: 18, bottom: 42, left: 0, width: 24 }, 240, 320).left).toBe(120);
  });

  it("keeps explicitly essential tooltips enabled when the workspace opts out", () => {
    const disabledWorkspace = fakeTooltipElement('[data-texlite-tooltips="off"]');
    const essentialControl = fakeTooltipElement('[data-texlite-tooltips="off"]', "[data-texlite-tooltip-always]");
    expect(tooltipIsDisabled(disabledWorkspace)).toBe(true);
    expect(tooltipIsDisabled(essentialControl)).toBe(false);
  });
});

function fakeTooltipElement(...ancestors: string[]): { closest: (selector: string) => unknown } {
  const matches = new Set(ancestors);
  return { closest: (selector) => matches.has(selector) ? {} : null };
}
