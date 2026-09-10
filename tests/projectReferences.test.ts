import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  title = {A bibliography entry}
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
      "\\input{../preamble}",
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
});

function referenceConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000, basePath: "/",
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
