import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("../src/client/textLanguageSupport"); vi.resetModules(); });

describe("auxiliary language bundle loading", () => {
  it("does not initialize auxiliary parsers for detection, LaTeX, BibTeX or plain text", async () => {
    const moduleFactory = vi.fn(() => ({ textLanguageSupport: vi.fn(() => []) }));
    vi.doMock("../src/client/textLanguageSupport", moduleFactory);
    const languages = await import("../src/client/textLanguages");
    expect(languages.textLanguageKind("settings.json")).toBe("json");
    expect(languages.isLatexEditorFile("paper.TEX")).toBe(true);
    for (const name of ["main.tex", "refs.bib", "plain.bst", "notes.txt", "LICENSE", "data.unknown"]) {
      expect(await languages.loadTextFileLanguage(name)).toEqual([]);
    }
    expect(moduleFactory).not.toHaveBeenCalled();
  });

  it("shares one module initialization across concurrent files and subsequent projects", async () => {
    const textLanguageSupport = vi.fn(() => []);
    const moduleFactory = vi.fn(() => ({ textLanguageSupport }));
    vi.doMock("../src/client/textLanguageSupport", moduleFactory);
    const { loadTextFileLanguage } = await import("../src/client/textLanguages");
    await Promise.all([loadTextFileLanguage("first/config.json"), loadTextFileLanguage("second/config.yml")]);
    await loadTextFileLanguage("third/script.py");
    expect(moduleFactory).toHaveBeenCalledTimes(1);
    expect(textLanguageSupport.mock.calls).toEqual([["json"], ["yaml"], ["python"]]);
  });

  it("clears a failed import so that a later request can retry", async () => {
    const textLanguageSupport = vi.fn(() => []);
    const moduleFactory = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue({ textLanguageSupport });
    vi.doMock("../src/client/textLanguageSupport", moduleFactory);
    const { loadTextFileLanguage } = await import("../src/client/textLanguages");
    await expect(loadTextFileLanguage("config.json")).rejects.toThrow();
    await expect(loadTextFileLanguage("config.json")).resolves.toEqual([]);
    expect(moduleFactory).toHaveBeenCalledTimes(2);
  });
});
