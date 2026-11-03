// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CitationContentFields } from "../src/client/CitationContentFields";
import i18n from "../src/client/i18n";
import { citationEditor, replaceCitationBibtex } from "./helpers/citationEditor";

it("preserves unsaved BibTeX and notes across accessible tabs and previews the latest Markdown and math without saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await import("../src/client/CitationBibtexEditor");
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Form() {
    const [bibtex, setBibtex] = useState("@article{paper, title={Original}}");
    const [notes, setNotes] = useState("");
    return createElement(CitationContentFields, { bibtex, notes, onBibtex: setBibtex, onNotes: setNotes });
  }
  const change = async (input: HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(createElement(Form)));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panel = () => [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((node) => !node.hidden)!;
    const bibtex = citationEditor(host);
    const notes = host.querySelector<HTMLTextAreaElement>(".citation-notes-input")!;
    expect(tabs.map((tab) => tab.textContent)).toEqual(["BibTeX", "Notes", "Notes preview"]);
    expect(panel().contains(bibtex.contentDOM)).toBe(true);
    await act(async () => replaceCitationBibtex(host, "@article{paper, title={Draft}}"));
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(panel().contains(notes)).toBe(true);
    await change(notes, "# Unsaved\n\n$E=mc^2$");
    await act(async () => { tabs[2].click(); await import("../src/client/CitationNotesPreview"); });
    expect(panel().querySelector("h1")?.textContent).toBe("Unsaved");
    expect(panel().querySelector(".katex")).not.toBeNull();
    await act(async () => tabs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(panel().contains(bibtex.contentDOM)).toBe(true);
    expect(citationEditor(host)).toBe(bibtex);
    expect(bibtex.state.doc.toString()).toBe("@article{paper, title={Draft}}");
    await act(async () => tabs[1].click());
    expect(notes.value).toBe("# Unsaved\n\n$E=mc^2$");
    await change(notes, "# Revised\n\n$$\n\\frac{1}{2}\n$$");
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(panel().querySelector("h1")?.textContent).toBe("Revised");
    expect(panel().querySelector(".katex-display")).not.toBeNull();
    expect(tabs[2].getAttribute("aria-controls")).toBe(panel().id);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
