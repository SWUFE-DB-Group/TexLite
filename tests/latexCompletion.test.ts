import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { LatexCompletionService } from "../src/server/latexCompletion.js";

const roots: string[] = [];

describe("LaTeX completion cache", () => {
  it("separates document classes from files and indexes bibliography definitions, not cite uses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const source = path.join(root, "projects", "paper", "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\documentclass[review]{custom}
\usepackage[options]{mypackage}
\cite{used2026}
\bibitem[Author(2026)]{paper2026} Reference text`);
    fs.writeFileSync(path.join(source, "references.bib"), [
      "@comment{fake2026, title = {Not a reference}}",
      "@article(frombib2026, url = {https://example.com/%20}, title = {A reference})",
      "@book{afterpercent2026, title = {Still indexed}}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "local.cls"), "");
    fs.writeFileSync(path.join(source, "figure.png"), "image");
    const result = await new LatexCompletionService(completionConfig(root)).build("paper");
    expect(result.classes.map((item) => item.label)).toEqual(expect.arrayContaining(["article", "custom", "local"]));
    expect(result.classes.map((item) => item.label)).not.toContain("figure.png");
    expect(result.files.map((item) => item.label)).not.toContain("article");
    expect(result.packages.map((item) => item.label)).toContain("mypackage");
    expect(result.citations.map((item) => item.label)).toEqual(expect.arrayContaining(["frombib2026", "afterpercent2026"]));
    expect(result.citations.map((item) => item.label)).not.toContain("paper2026");
    expect(result.citations.map((item) => item.label)).not.toContain("used2026");
    expect(result.citations.map((item) => item.label)).not.toContain("fake2026");
  });

  it("keeps custom command argument shapes while ignoring literal examples", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const source = path.join(root, "projects", "paper", "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\newcommand{\note}[2][blue]{#2}
\NewDocumentCommand{\demo}{O{red} m}{#2}
\begin{lstlisting}
\newcommand{\fake}[1]{#1}
\end{lstlisting}
% \begin{verbatim}
\newcommand{\realaftercomment}[1]{#1}
\end{verbatim}
\\begin{verbatim}
\newcommand{\realafterescaped}[1]{#1}
\end{verbatim}
\verb|\newcommand{\inlinefake}[1]{#1}| \verb|%| \newcommand{\realafterverb}[1]{#1}`);

    const result = await new LatexCompletionService(completionConfig(root)).build("paper");
    expect(result.commands.find((item) => item.label === "\\note")).toMatchObject({ apply: "\\note[${1}]{${2}}" });
    expect(result.commands.find((item) => item.label === "\\demo")).toMatchObject({ apply: "\\demo[${1}]{${2}}" });
    expect(result.commands.find((item) => item.label === "\\realaftercomment")).toMatchObject({ apply: "\\realaftercomment{${1}}" });
    expect(result.commands.find((item) => item.label === "\\realafterescaped")).toMatchObject({ apply: "\\realafterescaped{${1}}" });
    expect(result.commands.find((item) => item.label === "\\realafterverb")).toMatchObject({ apply: "\\realafterverb{${1}}" });
    expect(result.commands.map((item) => item.label)).not.toEqual(expect.arrayContaining(["\\fake", "\\inlinefake"]));
  });

  it("uses the shared reference scanner for project labels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const source = path.join(root, "projects", "paper", "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\\label{escaped-label}
\label{visible-label}
\hypertarget{target-label}{Anchor}`);

    const result = await new LatexCompletionService(completionConfig(root)).build("paper");
    expect(result.labels.map((item) => item.label)).toEqual(expect.arrayContaining(["visible-label", "target-label"]));
    expect(result.labels.map((item) => item.label)).not.toContain("escaped-label");
  });

  it("scopes BibTeX candidates to the selected root document and its input graph", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const source = path.join(root, "projects", "paper", "source");
    fs.mkdirSync(path.join(source, "chapters"), { recursive: true });
    fs.mkdirSync(path.join(source, "bibliography"), { recursive: true });
    fs.writeFileSync(path.join(source, "first.tex"), String.raw`\documentclass{article}
\input{chapters/first}`);
    fs.writeFileSync(path.join(source, "chapters", "first.tex"), String.raw`\addbibresource{../bibliography/first.bib}`);
    fs.writeFileSync(path.join(source, "second.tex"), String.raw`\documentclass{article}
\bibliography{bibliography/second}`);
    fs.writeFileSync(path.join(source, "empty.tex"), String.raw`\documentclass{article}`);
    fs.writeFileSync(path.join(source, "bibliography", "first.bib"), "@article{firstOnly, title={First}}\n@article{shared, title={Selected}}\n");
    fs.writeFileSync(path.join(source, "bibliography", "second.bib"), "@article{secondOnly, title={Second}}\n");
    fs.writeFileSync(path.join(source, "archive.bib"), "@article{shared, title={Stale}}\n@article{archiveOnly, title={Archive}}\n");
    const service = new LatexCompletionService(completionConfig(root));

    const first = await service.build("paper", "first.tex");
    expect(first.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "firstOnly", source: "bibliography/first.bib" }),
      expect.objectContaining({ label: "shared", source: "bibliography/first.bib" })
    ]));
    expect(first.citations.map((item) => item.label)).not.toEqual(expect.arrayContaining(["secondOnly", "archiveOnly"]));

    const second = await service.build("paper", "second.tex");
    expect(second.citations).toEqual([expect.objectContaining({ label: "secondOnly", source: "bibliography/second.bib" })]);

    const empty = await service.build("paper", "empty.tex");
    expect(empty.citations).toEqual([]);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds per-file symbol caches together with completion results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const service = new LatexCompletionService(completionConfig(root));

    for (let index = 0; index < 65; index += 1) {
      const projectId = `project-${index}`;
      const source = path.join(root, "projects", projectId, "source");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "main.tex"), `\\newcommand{\\project${index}}{value}\n`);
      await service.build(projectId);
    }

    expect(service.stats()).toEqual({
      cachedProjects: 64,
      cachedSymbolProjects: 64,
      cachedFiles: 64,
      pending: 0
    });

    service.invalidate("project-64");
    expect(service.stats()).toEqual({
      cachedProjects: 63,
      cachedSymbolProjects: 63,
      cachedFiles: 63,
      pending: 0
    });
  });
});

function completionConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000, basePath: "/",
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024, git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
