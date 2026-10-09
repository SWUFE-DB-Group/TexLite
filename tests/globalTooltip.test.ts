import { describe, expect, it } from "vitest";
import { globalTooltipPosition, tooltipIsDisabled } from "../src/client/GlobalTooltip";

describe("global tooltip placement", () => {
  it("places ordinary controls above their anchor", () => {
    expect(globalTooltipPosition({ top: 240, bottom: 272, left: 100, width: 40 }, 1200))
      .toEqual({ placement: "above", top: 232, left: 160 });
  });

  it("keeps the above placement for controls close to the viewport top", () => {
    expect(globalTooltipPosition({ top: 18, bottom: 42, left: 0, width: 24 }, 320))
      .toEqual({ placement: "above", top: 10, left: 152 });
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
