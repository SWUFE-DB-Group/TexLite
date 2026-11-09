// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpellCheckIssue } from "../src/client/spellCheck";
import { useChktex } from "../src/client/workspace/useChktex";
import { useSpellCheck } from "../src/client/workspace/useSpellCheck";

describe("writing issue identity", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  // The editor closes its suggestions menu when this list changes, and an
  // unrelated render (such as the editor losing focus) must not count.
  it("keeps the same list across unrelated renders when there are no issues", async () => {
    const seen: SpellCheckIssue[][] = [];
    const dictionaryWords: string[] = [];
    const Probe = () => {
      const chktex = useChktex({ active: false, projectId: "p", activeFile: "main.tex", content: "text" });
      const spelling = useSpellCheck({ active: true, harperEnabled: false, projectId: "p", activeFile: "main.tex", content: "text", dictionaryWords, additionalIssues: chktex.issues });
      seen.push(spelling.issues);
      return null;
    };
    await act(async () => root.render(createElement(Probe)));
    const settled = seen.length;
    await act(async () => root.render(createElement(Probe)));
    expect(seen.length).toBeGreaterThan(settled);
    expect(seen.at(-1)).toBe(seen[settled - 1]);
  });
});
