// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import CitationNotesPreview from "../src/client/CitationNotesPreview";
import i18n from "../src/client/i18n";

it("renders Markdown lists, code, tables and links without executing embedded HTML or unsafe URLs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const notes = "# Notes\n\n- **Important** result\n- `\\alpha`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Source](https://example.org)\n\n[Unsafe](javascript:alert%281%29)\n\n<script>window.compromised=true</script>\n\n<img src=x onerror=alert(1)>";
    await act(async () => root.render(createElement(CitationNotesPreview, { notes })));
    const rendered = host.querySelector(".citation-notes-markdown")!;
    expect(rendered.querySelector("h1")?.textContent).toBe("Notes");
    expect(rendered.querySelector("li strong")?.textContent).toBe("Important");
    expect(rendered.querySelector("code")?.textContent).toBe("\\alpha");
    expect(rendered.querySelectorAll("table tbody td").length).toBe(2);
    expect(rendered.querySelector('a[href="https://example.org"]')?.getAttribute("rel")).toContain("noopener");
    expect(rendered.querySelector('a[href^="javascript:"], script, [onerror]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("renders inline and block math while leaving escaped dollars, inline code and fenced code unchanged", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const notes = "Inline $x^2 + \\alpha$.\n\n$$\n\\frac{a}{b} = \\sqrt{c}\n$$\n\nEscaped \\$5. Inline `$not math$`.\n\n```tex\n$also not math$\n```";
    await act(async () => root.render(createElement(CitationNotesPreview, { notes })));
    expect(host.querySelectorAll(".katex")).toHaveLength(2);
    expect(host.querySelector("p .katex math")).not.toBeNull();
    expect(host.querySelector(".citation-notes-equation .katex-display math mfrac")).not.toBeNull();
    expect(host.textContent).toContain("Escaped $5");
    expect(host.querySelector("pre code.language-tex")?.textContent).toBe("$also not math$\n");
    expect([...host.querySelectorAll("code")].some((node) => node.textContent === "$not math$")).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("keeps malformed or recursive math local to the formula and refuses trusted HTML and resource-loading commands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const notes = "# Still readable\n\n$\\frac{a}{$\n\n$\\def\\loop{\\loop}\\loop$\n\n$\\href{javascript:alert(1)}{click}$\n\n$\\includegraphics{https://example.org/tracker.png}$\n\n$\\htmlClass{injected}{x}$\n\nNormal ending.";
    await act(async () => root.render(createElement(CitationNotesPreview, { notes })));
    expect(host.querySelector("h1")?.textContent).toBe("Still readable");
    expect(host.querySelectorAll(".katex-error").length).toBeGreaterThan(0);
    expect(host.textContent).toContain("Normal ending.");
    expect(host.querySelector('a[href^="javascript:"], img, .injected, script')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
