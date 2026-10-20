import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle } from "@codemirror/language";
import { history, undoDepth } from "@codemirror/commands";
import { editorPalettes, editorThemeVariables, type EditorPalette, type EditorTheme } from "../src/client/editorThemes";
import { editorColorScheme, editorGenericHighlightStyle } from "../src/client/editorThemeExtension";

const css = fs.readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

function luminance(hex: string): number {
  if (hex.length === 4) hex = `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const srgb = Number.parseInt(value, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe.each(["light", "dark"] as const)("%s editor palette", (theme) => {
  const palette = editorPalettes[theme];
  it.each(["ink", "cmd", "structure", "env", "math", "key", "task", "special", "comment", "bracket"])("keeps %s text at WCAG AA contrast on the editor background", (name) => {
    expect(contrast(palette[name as keyof EditorPalette], palette["editor-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("shares structural and environment color, and keeps reference keys distinct from warnings", () => {
    expect(palette.structure).toBe(palette.env);
    expect(palette.key).not.toBe(palette.warning);
    expect(css).toContain(".cm-tl-bracket { color: var(--tl-bracket)");
  });

  it("keeps the active-line tint translucent so it cannot obscure drawn selections", () => {
    const activeLine = palette["active-line"];
    expect(activeLine).toMatch(/^#[0-9A-F]{8}$/i);
    expect(Number.parseInt(activeLine.slice(-2), 16)).toBeLessThan(255);
  });

  it("keeps paired text readable over its accent background", () => {
    expect(contrast(palette["match-fg"], palette["match-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["tooltip-fg", "tooltip-bg"], ["tooltip-detail", "tooltip-bg"], ["tooltip-muted", "tooltip-bg"],
    ["completion-active-fg", "completion-active-bg"], ["panel-fg", "panel-bg"], ["panel-muted", "panel-bg"],
    ["input-fg", "input-bg"], ["control-fg", "input-bg"], ["vim-fg", "vim-bg"],
    ["spell-active-fg", "spell-active-bg"], ["selection-action-fg", "selection-action-bg"],
    ["history-action-fg", "history-action-bg"]
  ] as const)("keeps %s readable on %s", (foreground, background) => {
    expect(contrast(palette[foreground], palette[background])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("editor theme integration", () => {
  it("keeps dark comments below syntax and ordinary line numbers below comments", () => {
    const palette = editorPalettes.dark;
    expect(luminance(palette.comment)).toBeLessThan(luminance(palette.cmd));
    expect(luminance(palette.comment)).toBeLessThan(luminance(palette.bracket));
    expect(luminance(palette.gutter)).toBeLessThan(luminance(palette.comment));
    expect(palette["code-comment"]).toBe(palette.comment);
  });

  it("resolves every editor CSS color token in each palette", () => {
    for (const theme of ["light", "dark"] as const) {
      const variables = editorThemeVariables(theme);
      for (const match of css.matchAll(/var\((--tl-[\w-]+)/g)) expect(variables[match[1]], match[1]).toBeDefined();
    }
  });

  it("preserves CodeMirror's generic light highlighter colors and tag precedence", () => {
    for (const [index, original] of defaultHighlightStyle.specs.entries()) {
      const adapted = editorGenericHighlightStyle.specs[index];
      expect(adapted.tag).toBe(original.tag);
      if (typeof original.color !== "string") continue;
      const variable = /^var\((--tl-[\w-]+)\)$/.exec(String(adapted.color));
      expect(variable, `Unmapped generic color ${original.color}`).not.toBeNull();
      expect(editorThemeVariables("light")[variable![1]].toLowerCase()).toBe(original.color.toLowerCase());
    }
  });

  it("keeps every dark generic and BibTeX token readable", () => {
    const palette = editorPalettes.dark;
    for (const [name, value] of Object.entries(palette)) {
      if (name.startsWith("code-") || name === "bib-command" || name === "bib-protected") {
        expect(contrast(value, palette["editor-bg"]), name).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps dark syntax readable under selection and search highlights", () => {
    const palette = editorPalettes.dark;
    for (const background of ["selection-bg", "selection-inactive-bg", "search-bg"] as const) {
      for (const foreground of ["ink", "cmd", "structure", "math", "key", "special", "comment-selected", "bracket"] as const) {
        expect(contrast(palette[foreground], palette[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("changes the color scheme without replacing the document, selection or undo history", () => {
    const appearance = new Compartment();
    let state = EditorState.create({ doc: "A paper", extensions: [history(), appearance.of(editorColorScheme("light"))] });
    state = state.update({ changes: { from: 7, insert: "." }, selection: { anchor: 8 } }).state;
    const document = state.doc, selection = state.selection;
    for (const theme of ["dark", "light", "dark"] satisfies EditorTheme[]) {
      state = state.update({ effects: appearance.reconfigure(editorColorScheme(theme)) }).state;
      expect(state.facet(EditorView.darkTheme)).toBe(theme === "dark");
      expect(state.doc).toBe(document);
      expect(state.selection).toBe(selection);
      expect(undoDepth(state)).toBe(1);
    }
  });

  it("loads real regular and semibold Iosevka weights together", () => {
    const html = fs.readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
    expect(html).toContain("@fontsource/iosevka@5.2.5/400.css");
    expect(html).toContain("@fontsource/iosevka@5.2.5/600.css");
  });
});
