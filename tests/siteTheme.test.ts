import fs from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const css = fs.readFileSync(new URL("../src/client/siteTheme.css", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const tokens: Record<string, string> = {};
postcss.parse(css).walkDecls((declaration) => { if (declaration.prop.startsWith("--ui-")) tokens[declaration.prop] = declaration.value; });

function luminance(hex: string): number {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("application dark palette", () => {
  it("defines every semantic role used by the application", () => {
    const boundary = fs.readFileSync(new URL("../src/client/ErrorBoundary.tsx", import.meta.url), "utf8");
    for (const match of (css + styles + boundary).matchAll(/var\((--ui-[\w-]+)/g)) expect(tokens[match[1]], match[1]).toBeDefined();
  });

  it.each(["text", "muted", "accent", "danger", "warning", "info", "purple", "pink"])("keeps %s readable across the application surfaces", (role) => {
    const backgrounds = ["page", "surface", "raised", "subtle", "hover"];
    if (tokens[`--ui-${role}-bg`]) backgrounds.push(`${role}-bg`);
    for (const background of backgrounds) expect(contrast(tokens[`--ui-${role}`], tokens[`--ui-${background}`]), `${role} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps PDF paper white and does not invert document or image contents", () => {
    const sheet = postcss.parse(styles);
    const pdfBackgrounds: string[] = [];
    sheet.walkRules(".pdf-document .pdfViewer", (rule) => { rule.walkDecls("--page-bg-color", (declaration) => { pdfBackgrounds.push(declaration.value); }); });
    expect(pdfBackgrounds).toEqual(["white"]);
    expect(css).not.toMatch(/filter\s*:\s*invert/);
  });

  it("keeps primary agent actions readable on hover in both themes", () => {
    const agents = postcss.parse(fs.readFileSync(new URL("../src/client/agents/agents.css", import.meta.url), "utf8"));
    const selector = ".agent-management button.primary:hover:not(:disabled), .agent-terminal-panel button.primary:hover:not(:disabled)";
    let hoverBackground: string | undefined;
    agents.walkRules(selector, (rule) => {
      rule.walkDecls("background", (declaration) => { hoverBackground = declaration.value; });
    });
    // This selector must beat the generic button:hover rule, which uses a pale
    // surface background while a primary button retains contrasting text.
    expect(hoverBackground).toBe("color-mix(in srgb, var(--ui-accent, #176b44), #000 12%)");
    for (const [accent, foreground] of [["#176b44", "#ffffff"], [tokens["--ui-accent"], tokens["--ui-surface"]]]) {
      const hovered = `#${accent.slice(1).match(/../g)!.map((channel) => Math.round(Number.parseInt(channel, 16) * .88).toString(16).padStart(2, "0")).join("")}`;
      expect(contrast(hovered, foreground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not apply the application root-page layout to PDFViewer pages", () => {
    const selectors: string[] = [];
    postcss.parse(styles).walkRules((rule) => { if (rule.selector === ".page") selectors.push(rule.selector); });
    expect(selectors).toEqual([]);
    expect(styles).toContain("#root > .page {");
  });
});
