import fs from "node:fs";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const variables = new Map([...css.matchAll(/(--tl-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));

function color(name: string): string {
  const value = variables.get(name);
  if (!value) throw new Error(`Missing editor palette color: ${name}`);
  const alias = /^var\((--tl-[\w-]+)\)$/.exec(value);
  return alias ? color(alias[1]) : value;
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const srgb = Number.parseInt(value, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe("editor palette contrast", () => {
  it.each(["ink", "cmd", "structure", "env", "math", "key", "task", "special", "comment"])("keeps %s text at WCAG AA contrast on the editor background", (name) => {
    const foreground = luminance(color(`--tl-${name}`));
    const background = luminance(color("--tl-editor-bg"));
    const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("shares structural and environment color, and keeps reference keys distinct from warnings", () => {
    expect(color("--tl-structure")).toBe(color("--tl-env"));
    expect(color("--tl-key")).not.toBe(color("--tl-warning"));
    expect(css).toContain(".cm-tl-bracket { color: var(--tl-comment)");
  });

  it("keeps the active-line tint translucent so it cannot obscure drawn selections", () => {
    const activeLine = color("--tl-active-line");
    expect(activeLine).toMatch(/^#[0-9A-F]{8}$/i);
    expect(Number.parseInt(activeLine.slice(-2), 16)).toBeLessThan(255);
  });

  it("keeps paired text readable over its accent background", () => {
    const foreground = luminance(color("--tl-match-fg"));
    const background = luminance(color("--tl-match-bg"));
    expect((background + 0.05) / (foreground + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it("loads real regular and semibold Iosevka weights together", () => {
    const html = fs.readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
    expect(html).toContain("@fontsource/iosevka@5.2.5/400.css");
    expect(html).toContain("@fontsource/iosevka@5.2.5/600.css");
  });
});
