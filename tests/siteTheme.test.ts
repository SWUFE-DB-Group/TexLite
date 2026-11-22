// @vitest-environment happy-dom
import fs from "node:fs";
import { URL as FileURL } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { terminalTheme, terminalThemes } from "../src/client/terminalTheme";

const css = fs.readFileSync(new FileURL("../src/client/siteTheme.css", import.meta.url), "utf8");
const styles = fs.readFileSync(new FileURL("../src/client/styles.css", import.meta.url), "utf8");
const tokens: Record<string, string> = {};
postcss.parse(css).walkDecls((declaration) => { if (declaration.prop.startsWith("--ui-")) tokens[declaration.prop] = declaration.value; });

const lightTokens: Record<string, string> = {};
const darkTokens: Record<string, string> = {};
postcss.parse(css).walkRules((rule) => {
  const target = rule.selector === ":root" ? lightTokens : rule.selector === ':root[data-theme="dark"]' ? darkTokens : null;
  if (!target) return;
  rule.walkDecls((declaration) => { if (declaration.prop.startsWith("--ui-")) target[declaration.prop] = declaration.value; });
});

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
  it("keeps the default terminal ANSI text and accents readable", () => {
    for (const role of ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack",
      "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
      expect(contrast(terminalTheme[role], terminalTheme.background), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.entries(terminalThemes))("keeps %s terminal text, selection, cursor and preview hints readable", (_id, { colors, muted, preview }) => {
    expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.cursor, colors.cursorAccent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, colors.background)).toBeGreaterThanOrEqual(4.5);
    for (const background of [colors.selectionBackground, colors.selectionInactiveBackground]) {
      expect(contrast(colors.selectionForeground, background)).toBeGreaterThanOrEqual(4.5);
    }
    for (const [role, color] of Object.entries(preview)) {
      expect(contrast(color, colors.background), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("defines every semantic role used by the application", () => {
    const boundary = fs.readFileSync(new FileURL("../src/client/ErrorBoundary.tsx", import.meta.url), "utf8");
    for (const match of (css + styles + boundary).matchAll(/var\((--ui-[\w-]+)/g)) expect(tokens[match[1]], match[1]).toBeDefined();
  });

  it.each([["light", 820], ["dark", 820], ["light", 1600], ["dark", 1600]] as const)("keeps %s headers readable at %i px without changing primary actions", (theme, width) => {
    const originalTheme = document.documentElement.getAttribute("data-theme");
    const originalWidth = window.innerWidth;
    window.innerWidth = width;
    document.documentElement.dataset.theme = theme;
    const sheet = document.createElement("style"); sheet.textContent = styles + "\n" + css;
    const fixture = document.createElement("div");
    fixture.innerHTML = `<header class="topbar"><div class="top-actions"><button class="ghost">Citation library</button></div></header>
      <header class="editor-topbar">
        <button class="back">Back</button><div class="project-heading"><small>main.tex · Saved</small></div>
        <span class="collaboration-avatar editing">A</span>
        <div class="editor-actions">
          <button class="comments-action">Comments</button><button class="active">Files</button>
          <button class="compile">Compile</button><button class="compile cancel-compile">Cancel</button>
          <div class="layout-segmented"><button class="layout-segment active">Editor &amp; PDF</button><button class="layout-segment">Editor only</button></div>
        </div>
      </header>`;
    document.head.append(sheet); document.body.append(fixture);
    try {
      const style = (selector: string) => getComputedStyle(fixture.querySelector(selector)!);
      const background = style(".topbar").backgroundColor;
      expect(style(".editor-topbar").backgroundColor).toBe(background);
      expect(style(".collaboration-avatar").borderTopColor).toBe(background);
      for (const selector of [".topbar", ".editor-topbar", ".project-heading small", ".comments-action", ".layout-segment:not(.active)"]) {
        expect(contrast(style(selector).color, background), selector).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokens["--ui-header-focus"], background)).toBeGreaterThanOrEqual(3);
      const active = style(".editor-actions .active");
      expect(contrast(active.color, active.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      const activeSegment = style(".layout-segment.active");
      expect(contrast(activeSegment.color, activeSegment.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      const compile = style(".compile:not(.cancel-compile)");
      expect(contrast(compile.color, compile.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(style(".cancel-compile").backgroundColor).not.toBe(compile.backgroundColor);
    } finally {
      fixture.remove(); sheet.remove();
      window.innerWidth = originalWidth;
      if (originalTheme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", originalTheme);
    }
  });

  it.each(["light", "dark"] as const)("keeps all semantic text roles readable across %s application surfaces", (mode) => {
    const palette = mode === "light" ? lightTokens : { ...lightTokens, ...darkTokens };
    for (const role of ["text", "muted", "accent", "danger", "warning", "info", "purple", "pink"]) {
      const backgrounds = ["page", "surface", "raised", "subtle", "hover"];
      if (palette[`--ui-${role}-bg`]) backgrounds.push(`${role}-bg`);
      for (const background of backgrounds) {
        expect(contrast(palette[`--ui-${role}`], palette[`--ui-${background}`]), `${mode}: ${role} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(palette["--ui-primary-fg"], palette["--ui-primary-bg"]), `${mode}: primary`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-compile-fg"], palette["--ui-compile-bg"]), `${mode}: compile`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-code-text"], palette["--ui-code-bg"]), `${mode}: code`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-console-text"], palette["--ui-console-bg"]), `${mode}: console`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-console-muted"], palette["--ui-console-bg"]), `${mode}: console muted`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-console-warning-text"], palette["--ui-console-warning-bg"]), `${mode}: console warning`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["--ui-console-error-text"], palette["--ui-console-error-bg"]), `${mode}: console error`).toBeGreaterThanOrEqual(4.5);
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
