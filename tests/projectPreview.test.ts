import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { extractProjectPreview, PROJECT_PREVIEW_BYTES, ProjectPreviewService } from "../src/server/projectPreview.js";

let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

describe("project preview extraction", () => {
  it("extracts separate title and opening abstract text, hiding citation keys and flattening formatting", () => {
    const source = String.raw`\title[Short]{The \textbf{Paper {Title}}}
      % \begin{abstract}Not the abstract.\end{abstract}
      \begin{verbatim}\begin{abstract}Literal only.\end{abstract}\end{verbatim}
      \begin{document}\begin{abstract}
      We improve \emph{multimodal {retrieval}} by 40.16\%~\citep{private-key}.
      This second sentence is also part of the preview.
      \end{abstract}\end{document}`;
    expect(extractProjectPreview(source)).toEqual({ title: "The Paper Title", abstract: "We improve multimodal retrieval by 40.16%. This second sentence is also part of the preview." });
  });

  it("falls back to the real title, preserving Unicode and ignoring commented or literal titles", () => {
    expect(extractProjectPreview(String.raw`% \title{Ignored}
      \verb|\title{Literal}|
      \title[Short]{研究 \textbf{多模態} \LaTeX{} \& collaboration}`)).toEqual({ title: "研究 多模態 LaTeX & collaboration", abstract: "" });
    expect(extractProjectPreview(String.raw`\title{Fallback}\begin{abstract}% only a comment
      \end{abstract}`)).toEqual({ title: "Fallback", abstract: "" });
  });

  it("handles CJK sentences and long excerpts without breaking surrogate pairs", () => {
    expect(extractProjectPreview(String.raw`\begin{abstract}這是第一句。這是第二句。\end{abstract}`)).toEqual({ title: "", abstract: "這是第一句。這是第二句。" });
    const long = extractProjectPreview(`\\begin{abstract}${"😀".repeat(300)}\\end{abstract}`)!.abstract;
    expect(Array.from(long)).toHaveLength(241); expect(long.endsWith("😀…")).toBe(true);
  });

  it("distinguishes empty content from prose that cannot be previewed without expansion or includes", () => {
    expect(extractProjectPreview("% a comment\n")).toEqual({ title: "", abstract: "" });
    expect(extractProjectPreview("\\begin{document}\n% a comment\n\\end{document}")).toEqual({ title: "", abstract: "" });
    expect(extractProjectPreview(String.raw`\begin{document}\input{chapters/intro}\end{document}`)).toBeNull();
    expect(extractProjectPreview(String.raw`\documentclass{article}`)).toBeNull();
  });

  it("does not mistake body text, layout options or included metadata for a title or abstract", () => {
    expect(extractProjectPreview(String.raw`\begin{document}Hello \textbf{world}. Another sentence.\end{document}`)).toBeNull();
    const template = String.raw`\documentclass{sjtuthesis}
      \input{setup}
      \begin{document}
      \input{contents/封面}
      \pagenumbering{arabic}
      \setcounter{page}{1}
      \pagestyle{fancy}
      \input{contents/abstract}
      \tableofcontents[notintoc]
      \end{document}`;
    expect(extractProjectPreview(template)).toBeNull();
    expect(extractProjectPreview(String.raw`\title{Real title}` + template)).toEqual({ title: "Real title", abstract: "" });
  });

  it("requires complete title arguments and abstract environments, falling back only to a valid title", () => {
    expect(extractProjectPreview(String.raw`\title{Unclosed title`)).toBeNull();
    expect(extractProjectPreview(String.raw`\begin{abstract}Unfinished abstract. \section{Body}`)).toBeNull();
    expect(extractProjectPreview(String.raw`\title{Real title}\begin{abstract}Unfinished abstract.`)).toEqual({ title: "Real title", abstract: "" });
  });
});

describe("bounded project preview reads", () => {
  function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-previews-"));
    const config = { projectsDir: path.join(root, "projects") } as Config;
    const source = path.join(config.projectsDir, "project", "source");
    fs.mkdirSync(source, { recursive: true });
    return { service: new ProjectPreviewService(config), source };
  }

  it("coalesces concurrent reads, caches unchanged metadata and refreshes content and main-file changes", async () => {
    const { service, source } = setup();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{First}`);
    fs.writeFileSync(path.join(source, "other.tex"), String.raw`\title{Other}`);
    const open = vi.spyOn(fs.promises, "open");
    await expect(Promise.all([service.read("project", "main.tex"), service.read("project", "main.tex")])).resolves.toEqual([{ title: "First", abstract: "" }, { title: "First", abstract: "" }]);
    await expect(service.read("project", "main.tex")).resolves.toEqual({ title: "First", abstract: "" });
    expect(open).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Revised title}`);
    await expect(service.read("project", "main.tex")).resolves.toEqual({ title: "Revised title", abstract: "" });
    await expect(service.read("project", "other.tex")).resolves.toEqual({ title: "Other", abstract: "" });
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("reads only the bounded prefix and does not label a truncated comment preamble as empty", async () => {
    const { service, source } = setup();
    fs.writeFileSync(path.join(source, "main.tex"), "%" + "x".repeat(PROJECT_PREVIEW_BYTES) + "\n\\title{Outside the preview}");
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Early title}` + "%" + "x".repeat(PROJECT_PREVIEW_BYTES * 2));
    await expect(service.read("project", "main.tex")).resolves.toEqual({ title: "Early title", abstract: "" });
  });

  it("does not publish a partial abstract when its closing delimiter lies beyond the bounded read", async () => {
    const { service, source } = setup();
    const abstract = String.raw`\begin{abstract}A complete first sentence. ` + "x".repeat(PROJECT_PREVIEW_BYTES) + String.raw`\end{abstract}`;
    fs.writeFileSync(path.join(source, "main.tex"), abstract);
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Complete title}` + abstract);
    await expect(service.read("project", "main.tex")).resolves.toEqual({ title: "Complete title", abstract: "" });
  });

  it("tolerates missing, binary, directory and unsafe main files, and retries after they are fixed", async () => {
    const { service, source } = setup();
    await expect(service.read("project", "missing.tex")).resolves.toBeNull();
    await expect(service.read("project", "../outside.tex")).resolves.toBeNull();
    await expect(service.read("project", "")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), Buffer.from([0, 1, 2, 3]));
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Recovered}`);
    await expect(service.read("project", "main.tex")).resolves.toEqual({ title: "Recovered", abstract: "" });
    fs.unlinkSync(path.join(source, "main.tex"));
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
  });
});
