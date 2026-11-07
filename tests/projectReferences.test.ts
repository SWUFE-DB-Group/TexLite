import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { resolveProjectReference } from "../src/server/projectReferences.js";

const roots: string[] = [];

describe("project reference navigation", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers an in-source bibitem and otherwise resolves project bibliography and labels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-references-"));
    roots.push(root);
    const projectId = "references-project";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(path.join(source, "chapters"), { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\documentclass{article}
\begin{document}
\begin{thebibliography}{1}
\bibitem{manual2026} Manual entry.
\end{thebibliography}
\end{document}`);
    fs.writeFileSync(path.join(source, "refs.bib"), String.raw`@article{smith2025,
  author = {Smith, Ada},
  title = {A bibliography entry},
  year = {2025},
  journal = {Journal of Testing}
}
@article{manual2026,
  title = {A stale duplicate}
}`);
    fs.writeFileSync(path.join(source, "chapters", "results.tex"), String.raw`\section{Result}\label{sec:result}`);
    const config = referenceConfig(root);

    await expect(resolveProjectReference(config, projectId, "citation", "manual2026")).resolves.toMatchObject({
      path: "main.tex", line: 4, column: 1, kind: "citation", source: "bibitem"
    });
    await expect(resolveProjectReference(config, projectId, "citation", "smith2025")).resolves.toMatchObject({
      path: "refs.bib", line: 1, column: 1, kind: "citation", source: "bibtex"
    });
    await expect(resolveProjectReference(config, projectId, "label", "sec:result")).resolves.toMatchObject({
      path: "chapters/results.tex", line: 1, column: 17, kind: "label", source: "label"
    });
    await expect(resolveProjectReference(config, projectId, "citation", "missing")).resolves.toBeNull();
  });

  it("uses the selected main document's bibliography before unrelated project sources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-references-"));
    roots.push(root);
    const projectId = "main-document-order";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(path.join(source, "chapters"), { recursive: true });
    fs.mkdirSync(path.join(source, "bibliography"), { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), [
      "\\documentclass{article}",
      "\\input{chapters/intro}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "chapters", "intro.tex"), [
      "\\input{preamble}",
      "\\bibliography{../bibliography/references}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "preamble.tex"), "\\section{Preamble}\\label{sec:preamble}");
    fs.writeFileSync(path.join(source, "bibliography", "references.bib"), [
      "@article{shared2026,",
      "  title = {Current bibliography}",
      "}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "archive.tex"), [
      "\\begin{thebibliography}{1}",
      "\\bibitem{shared2026} Stale archive entry.",
      "\\end{thebibliography}"
    ].join("\n"));
    const config = referenceConfig(root);

    await expect(resolveProjectReference(config, projectId, "citation", "shared2026", {
      mainFile: "main.tex"
    })).resolves.toMatchObject({
      path: "bibliography/references.bib", line: 1, column: 1, kind: "citation", source: "bibtex"
    });
    await expect(resolveProjectReference(config, projectId, "label", "sec:preamble", {
      mainFile: "main.tex"
    })).resolves.toMatchObject({
      path: "preamble.tex", line: 1, column: 19, kind: "label", source: "label"
    });
  });

  it("reports a revision of the defining file that changes only when that file does", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-reference-revision-"));
    roots.push(root);
    const projectId = "revision-project";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\n\\begin{document}\\cite{a}\\bibliography{refs}\\end{document}\n");
    const refs = path.join(source, "refs.bib");
    fs.writeFileSync(refs, "@article{a, title={One}}\n");
    const config = referenceConfig(root);
    const lookup = () => resolveProjectReference(config, projectId, "citation", "a", { mainFile: "main.tex" });

    const first = await lookup();
    expect(first).toMatchObject({ path: "refs.bib", source: "bibtex" });
    expect(first?.revision).toMatch(/^\d+:[\d.]+$/);
    expect((await lookup())?.revision).toBe(first?.revision);

    // Unrelated edits elsewhere in the project must not invalidate the .bib parse.
    fs.writeFileSync(path.join(source, "main.tex"), "% edited\n\\documentclass{article}\n\\begin{document}\\cite{a}\\bibliography{refs}\\end{document}\n");
    expect((await lookup())?.revision).toBe(first?.revision);

    fs.writeFileSync(refs, "@article{a, title={Longer title}}\n");
    const edited = await lookup();
    expect(edited?.revision).toBeTruthy();
    expect(edited?.revision).not.toBe(first?.revision);
  });

  it("reuses source snapshots but notices changed file metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-reference-cache-"));
    roots.push(root);
    const projectId = "source-cache-project";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    const mainFile = path.join(source, "main.tex");
    const original = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{thebibliography}{1}",
      "\\bibitem{cached2026} Cached entry.",
      "\\end{thebibliography}",
      "\\end{document}"
    ].join("\n");
    fs.writeFileSync(mainFile, original);
    const config = referenceConfig(root);

    await expect(resolveProjectReference(config, projectId, "citation", "cached2026"))
      .resolves.toMatchObject({ path: "main.tex", line: 4, source: "bibitem" });
    fs.writeFileSync(mainFile, `% shifted\n${original}`);
    await expect(resolveProjectReference(config, projectId, "citation", "cached2026"))
      .resolves.toMatchObject({ path: "main.tex", line: 5, source: "bibitem" });
  });
});

describe("project reference source cache lifetime", () => {
  const TTL = 15_000;
  const tempRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-reference-lifetime-"));
    roots.push(root);
    return root;
  };
  const writeProject = (root: string, projectId: string) => {
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\begin{thebibliography}{1}\n\\bibitem{k} Entry.\n\\end{thebibliography}\n");
  };
  // The cache is module state with its own timer, so each test gets a fresh
  // module instance created under the fake clock. Only timers and the clock
  // are faked: file reads must keep using the real event loop.
  const freshModule = async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.resetModules();
    return await import("../src/server/projectReferences.js");
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("frees an idle project's sources when they expire and then stops its timer", async () => {
    const references = await freshModule();
    const root = tempRoot();
    writeProject(root, "idle");
    const config = referenceConfig(root);

    await references.resolveProjectReference(config, "idle", "citation", "k");
    expect(references.projectReferenceCacheStats().projects).toBe(1);
    expect(references.projectReferenceCacheStats().bytes).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(references.projectReferenceCacheStats().projects).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(references.projectReferenceCacheStats()).toEqual({ projects: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms for the next expiry so staggered projects are each released on time", async () => {
    const references = await freshModule();
    const root = tempRoot();
    writeProject(root, "early");
    writeProject(root, "late");
    const config = referenceConfig(root);

    await references.resolveProjectReference(config, "early", "citation", "k");
    await vi.advanceTimersByTimeAsync(10_000);
    await references.resolveProjectReference(config, "late", "citation", "k");
    expect(references.projectReferenceCacheStats().projects).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(references.projectReferenceCacheStats().projects).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(references.projectReferenceCacheStats().projects).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(references.projectReferenceCacheStats()).toEqual({ projects: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let the sweep timer keep the process alive", async () => {
    const references = await freshModule();
    const unref = vi.fn();
    const clockSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = clockSetTimeout(...args);
      const original = timer.unref.bind(timer);
      timer.unref = () => { unref(); return original(); };
      return timer;
    }) as typeof setTimeout);
    const root = tempRoot();
    writeProject(root, "unref");

    await references.resolveProjectReference(referenceConfig(root), "unref", "citation", "k");
    expect(setTimeout).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
  });

  it("keeps byte accounting exact while evicting beyond the project limit", async () => {
    const references = await freshModule();
    const root = tempRoot();
    const config = referenceConfig(root);
    for (let index = 0; index < 18; index += 1) {
      writeProject(root, `bulk-${index}`);
      await references.resolveProjectReference(config, `bulk-${index}`, "citation", "k");
    }
    const perProject = fs.statSync(path.join(root, "projects", "bulk-0", "source", "main.tex")).size;
    expect(references.projectReferenceCacheStats()).toEqual({ projects: 16, bytes: 16 * perProject });

    await vi.advanceTimersByTimeAsync(TTL);
    expect(references.projectReferenceCacheStats()).toEqual({ projects: 0, bytes: 0 });
  });
});

function referenceConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000, basePath: "/",
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxSegments: 20_000,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
  };
}
