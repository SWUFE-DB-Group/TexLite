import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { extractProjectPreview, PROJECT_PREVIEW_BYTES, ProjectPreviewService } from "../src/server/projectPreview.js";

let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

describe("project preview extraction", () => {
  it("prefers the abstract's first sentence, hides citation keys and flattens nested formatting", () => {
    const source = String.raw`\title[Short]{The \textbf{Paper {Title}}}
      % \begin{abstract}Not the abstract.\end{abstract}
      \begin{verbatim}\begin{abstract}Literal only.\end{abstract}\end{verbatim}
      \begin{document}\begin{abstract}
      We improve \emph{multimodal {retrieval}} by 40.16\%~\citep{private-key}.
      This second sentence must not appear.
      \end{abstract}\end{document}`;
    expect(extractProjectPreview(source)).toBe("We improve multimodal retrieval by 40.16%.");
  });

  it("falls back to the real title, preserving Unicode and ignoring commented or literal titles", () => {
    expect(extractProjectPreview(String.raw`% \title{Ignored}
      \verb|\title{Literal}|
      \title[Short]{研究 \textbf{多模態} \LaTeX{} \& collaboration}`)).toBe("研究 多模態 LaTeX & collaboration");
    expect(extractProjectPreview(String.raw`\title{Fallback}\begin{abstract}% only a comment
      \end{abstract}`)).toBe("Fallback");
  });

  it("handles CJK sentences, body-only projects and long excerpts without breaking surrogate pairs", () => {
    expect(extractProjectPreview(String.raw`\begin{abstract}這是第一句。這是第二句。\end{abstract}`)).toBe("這是第一句。");
    expect(extractProjectPreview(String.raw`\begin{document}Hello \textbf{world}. Another sentence.\end{document}`)).toBe("Hello world.");
    const long = extractProjectPreview(`\\begin{abstract}${"😀".repeat(300)}\\end{abstract}`)!;
    expect(Array.from(long)).toHaveLength(241); expect(long.endsWith("😀…")).toBe(true);
  });

  it("distinguishes empty content from prose that cannot be previewed without expansion or includes", () => {
    expect(extractProjectPreview("% a comment\n")).toBe("");
    expect(extractProjectPreview("\\begin{document}\n% a comment\n\\end{document}")).toBe("");
    expect(extractProjectPreview(String.raw`\begin{document}\input{chapters/intro}\end{document}`)).toBeNull();
    expect(extractProjectPreview(String.raw`\documentclass{article}`)).toBeNull();
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
    await expect(Promise.all([service.read("project", "main.tex"), service.read("project", "main.tex")])).resolves.toEqual(["First", "First"]);
    await expect(service.read("project", "main.tex")).resolves.toBe("First");
    expect(open).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Revised title}`);
    await expect(service.read("project", "main.tex")).resolves.toBe("Revised title");
    await expect(service.read("project", "other.tex")).resolves.toBe("Other");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("reads only the bounded prefix and does not label a truncated comment preamble as empty", async () => {
    const { service, source } = setup();
    fs.writeFileSync(path.join(source, "main.tex"), "%" + "x".repeat(PROJECT_PREVIEW_BYTES) + "\n\\title{Outside the preview}");
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Early title}` + "%" + "x".repeat(PROJECT_PREVIEW_BYTES * 2));
    await expect(service.read("project", "main.tex")).resolves.toBe("Early title");
  });

  it("tolerates missing, binary, directory and unsafe main files, and retries after they are fixed", async () => {
    const { service, source } = setup();
    await expect(service.read("project", "missing.tex")).resolves.toBeNull();
    await expect(service.read("project", "../outside.tex")).resolves.toBeNull();
    await expect(service.read("project", "")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), Buffer.from([0, 1, 2, 3]));
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
    fs.writeFileSync(path.join(source, "main.tex"), String.raw`\title{Recovered}`);
    await expect(service.read("project", "main.tex")).resolves.toBe("Recovered");
    fs.unlinkSync(path.join(source, "main.tex"));
    await expect(service.read("project", "main.tex")).resolves.toBeNull();
  });
});
