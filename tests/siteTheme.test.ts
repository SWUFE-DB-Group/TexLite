// @vitest-environment happy-dom
import fs from "node:fs";
import { URL as FileURL } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { terminalTheme } from "../src/client/terminalTheme";

const css = fs.readFileSync(new FileURL("../src/client/siteTheme.css", import.meta.url), "utf8");
const styles = fs.readFileSync(new FileURL("../src/client/styles.css", import.meta.url), "utf8");
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
  it("keeps fixed terminal text, ANSI accents, cursor and selections readable", () => {
    for (const role of ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack",
      "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
      expect(contrast(terminalTheme[role], terminalTheme.background), role).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(terminalTheme.cursor, terminalTheme.cursorAccent)).toBeGreaterThanOrEqual(4.5);
    for (const background of [terminalTheme.selectionBackground, terminalTheme.selectionInactiveBackground]) {
      expect(contrast(terminalTheme.selectionForeground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("defines every semantic role used by the application", () => {
    const boundary = fs.readFileSync(new FileURL("../src/client/ErrorBoundary.tsx", import.meta.url), "utf8");
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

  it("scopes application page rules away from nested PDFViewer pages", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.innerHTML = '<main class="page"><div class="pdf-document"><div class="pdfViewer"><div class="page"></div></div></div></main>';
    const applicationPage = root.firstElementChild!;
    const pdfPage = root.querySelector(".pdfViewer .page")!;
    const selectors: string[] = [];
    postcss.parse(styles).walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (selector.includes(".page") && applicationPage.matches(selector)) selectors.push(selector);
      }
    });
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(pdfPage.matches(selector), selector).toBe(false);
  });
});
