import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { documentSourceOrder, latexDocumentDirectives } from "../src/server/latexDocumentGraph.js";
import { ProjectOutlineService } from "../src/server/projectOutline.js";

const roots: string[] = [];

describe("project outline service", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("coalesces and invalidates cached outlines by project tree metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-outline-"));
    roots.push(root);
    const projectId = "project-outline";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\n\\input{sections/tex}\n");
    fs.mkdirSync(path.join(source, "sections"));
    fs.writeFileSync(path.join(source, "sections", "tex.tex"), "\\section{First}\n");
    const config = outlineConfig(root);
    const service = new ProjectOutlineService(config);

    const first = await service.build(projectId, "main.tex");
    expect(first).toEqual([expect.objectContaining({ path: "sections/tex.tex", title: "First" })]);
    expect(service.stats()).toMatchObject({ cachedOutlines: 1, pending: 0 });
    await expect(service.build(projectId, "main.tex")).resolves.toEqual(first);
    expect(service.stats()).toMatchObject({ cachedOutlines: 1, pending: 0 });

    fs.writeFileSync(path.join(source, "sections", "tex.tex"), "\\section{Updated}\n");
    const updated = await service.build(projectId, "main.tex");
    expect(updated).toEqual([expect.objectContaining({ path: "sections/tex.tex", title: "Updated" })]);
  });

  it("uses the shared scanner for comments, literals, optional titles, and source lines", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-outline-"));
    roots.push(root);
    const projectId = "project-outline-scanner";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(path.join(source, "sections"), { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), [
      "% \\section{Ignored comment} \\input{commented}",
      "\\section [Short title] % comment before the long title",
      "{Visible \\emph{title}}",
      "\\begin{verbatim}",
      "\\section{Ignored literal environment}",
      "\\input{ignored}",
      "\\end{verbatim}",
      "\\verb|\\section{Ignored inline literal}|",
      "\\input{sections/child}",
      "\\subsection{After child}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "commented.tex"), "\\section{Ignored commented include}\n");
    fs.writeFileSync(path.join(source, "ignored.tex"), "\\section{Ignored literal include}\n");
    fs.writeFileSync(path.join(source, "sections", "child.tex"), "\\section[Child]{Child \\textbf{section}}\n");
    const config = outlineConfig(root);

    const expected = [
      { path: "main.tex", line: 2, level: 1, title: "Visible title" },
      { path: "sections/child.tex", line: 1, level: 1, title: "Child section" },
      { path: "main.tex", line: 10, level: 2, title: "After child" }
    ];

    await expect(new ProjectOutlineService(config).build(projectId, "main.tex")).resolves.toEqual(expected);
  });

  it("keeps headings explicit, include paths static, and display titles compact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-outline-"));
    roots.push(root);
    const projectId = "project-outline-static";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(path.join(source, "chapters"), { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), [
      "\\section{Visible}",
      "\\toString{Not an outline heading}",
      "\\constructor{Also not an outline heading}",
      "\\section{Before% an inline comment that must not widen the title",
      "After}",
      "\\input{chapters\\chosen}",
      "\\input{static}"
    ].join("\n"));
    fs.writeFileSync(path.join(source, "chapters", "chosen.tex"), "\\section{Dynamically selected}\n");
    fs.writeFileSync(path.join(source, "static.tex"), "\\section{Static include}\n");
    const config = outlineConfig(root);
    const expected = [
      { path: "main.tex", line: 1, level: 1, title: "Visible" },
      { path: "main.tex", line: 4, level: 1, title: "Before \nAfter" },
      { path: "static.tex", line: 1, level: 1, title: "Static include" }
    ];

    await expect(new ProjectOutlineService(config).build(projectId, "main.tex")).resolves.toEqual(expected);
  });

  it("follows shared import semantics without changing depth-first source order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-outline-"));
    roots.push(root);
    const projectId = "project-outline-imports";
    const source = path.join(root, "projects", projectId, "source");
    const corpus = new Map<string, string>([
      [
        "main.tex",
        [
          "\\section{Before}",
          "\\import{chapters/}{intro}",
          "\\section{After import}",
          "\\input appendices/unbraced",
          "\\subfile{supplement/overview}",
          "\\section{After all}"
        ].join("\n")
      ],
      [
        "chapters/intro.tex",
        [
          "\\section{Introduction}",
          "\\input{method}",
          "\\input{fallback}",
          "\\subimport{nested/}{proof}"
        ].join("\n")
      ],
      ["method.tex", "\\section{Wrong root method}\n"],
      ["chapters/method.tex", "\\section{Chapter method}\n"],
      ["fallback.tex", "\\section{Root fallback}\n"],
      [
        "chapters/nested/proof.tex",
        [
          "\\section{Proof}",
          "\\input{detail}"
        ].join("\n")
      ],
      ["chapters/nested/detail.tex", "\\section{Proof detail}\n"],
      ["appendices/unbraced.tex", "\\section{Unbraced include}\n"],
      [
        "supplement/overview.tex",
        [
          "\\section{Overview}",
          "\\input{detail}"
        ].join("\n")
      ],
      ["supplement/detail.tex", "\\section{Supplement detail}\n"]
    ]);
    for (const [entryPath, content] of corpus) {
      const target = path.join(source, entryPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const config = outlineConfig(root);

    const expected = [
      ["main.tex", "Before"],
      ["chapters/intro.tex", "Introduction"],
      ["chapters/method.tex", "Chapter method"],
      ["fallback.tex", "Root fallback"],
      ["chapters/nested/proof.tex", "Proof"],
      ["chapters/nested/detail.tex", "Proof detail"],
      ["main.tex", "After import"],
      ["appendices/unbraced.tex", "Unbraced include"],
      ["supplement/overview.tex", "Overview"],
      ["supplement/detail.tex", "Supplement detail"],
      ["main.tex", "After all"]
    ];

    const outline = await new ProjectOutlineService(config).build(projectId, "main.tex");
    expect(outline.map(({ path: entryPath, title }) => [entryPath, title])).toEqual(expected);
    expect(documentSourceOrder(
      new Map([...corpus].map(([entryPath, content]) => [entryPath, latexDocumentDirectives(content)])),
      "main.tex"
    )).toEqual([
      "main.tex",
      "chapters/intro.tex",
      "appendices/unbraced.tex",
      "supplement/overview.tex",
      "chapters/method.tex",
      "fallback.tex",
      "chapters/nested/proof.tex",
      "supplement/detail.tex",
      "chapters/nested/detail.tex"
    ]);
  });
});

function outlineConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000, basePath: "/",
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxSegments: 20_000, git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
  };
}
