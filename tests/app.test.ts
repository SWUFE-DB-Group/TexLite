import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { CollaborationService } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";
import { sourceRoot } from "../src/server/files.js";

describe("texLite application", () => {
  const execFileAsync = promisify(execFile);
  let root: string;
  let config: Config;
  let db: DatabaseConnection;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-test-"));
    config = {
      configPath: path.join(root, "config.json"), siteName: "Test texLite", adminEmail: "admin@example.test",
      host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "missing-client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "pdflatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
      maxUploadBytes: 50 * 1024 * 1024, historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024
      , git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
    };
    db = openDatabase(config);
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'admin', 'Administrator', ?, 'admin', 0, 0, 1, ?)`)
      .run(randomUUID(), await hashPassword("administrator password"), new Date().toISOString());
    const githubFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/user") && init?.method === "GET") {
        return Response.json({ login: "texlite-owner" });
      }
      if (url.endsWith("/user/repos") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        return Response.json({
          name: body.name,
          clone_url: `https://github.com/texlite-owner/${body.name}.git`,
          html_url: `https://github.com/texlite-owner/${body.name}`,
          default_branch: "main"
        }, { status: 201 });
      }
      return Response.json({ message: "Not found" }, { status: 404 });
    };
    app = await buildApp(config, db, { logger: false, githubFetch });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "administrator password" } });
    expect(login.statusCode).toBe(200);
    cookie = login.headers["set-cookie"]!.split(";")[0];
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires authentication and exposes only public site config", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, pid: process.pid, latexmk: "latexmk" });
    const unauthenticated = await app.inject({ method: "GET", url: "/api/projects" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({ siteName: "Test texLite", adminEmail: "admin@example.test" });
  });

  it("does not expose a server-side spellcheck endpoint", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Client spellcheck" } });
    const response = await app.inject({
      method: "POST", url: `/api/projects/${created.json().project.id}/spellcheck`, headers: { cookie },
      payload: { source: "This wrng source must stay in the browser." }
    });
    expect(response.statusCode).toBe(404);
  });

  it("uses one collaboration size limit for the API and editable text files", async () => {
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({ maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 5 });
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Large source" } });
    const tooLarge = "x".repeat(5 * 1024 * 1024 + 1);
    const response = await app.inject({
      method: "PUT", url: `/api/projects/${created.json().project.id}/file`, headers: { cookie },
      payload: { path: "large.tex", content: tooLarge }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("formats supported LaTeX files with the optional host formatter", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Host formatter" } });
    const projectId = created.json().project.id as string;
    const response = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/format`, headers: { cookie },
      payload: { path: "main.tex", source: "\\documentclass{article}\n\\begin{document}\n\\section{Title}\n\\end{document}\n" }
    });
    expect([200, 503]).toContain(response.statusCode);
    if (response.statusCode === 200) expect(response.json()).toMatchObject({ formatter: "tex-fmt" });
    else expect(response.json()).toMatchObject({ code: "FORMATTER_UNAVAILABLE" });
  });

  it("creates, edits, compiles and comments on a project", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Paper" } });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    expect(project).toMatchObject({ ownerUsername: "admin", ownerDisplayName: "Administrator", lastModifiedUsername: "admin" });
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);

    const source = String.raw`\documentclass{article}
\begin{document}
\section{Hello}
It works.
\end{document}
`;
    const saved = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: source } });
    expect(saved.statusCode).toBe(200);
    const savedRc = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: ".latexmkrc", content: "$silent = 1;\n" } });
    expect(savedRc.statusCode).toBe(200);
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "paper.sty", content: String.raw`\ProvidesPackage{paper}
\newcommand{\reviewnote}[1]{\textbf{#1}}
\NewDocumentCommand{\reviewpair}{m o}{#1 #2}
\def\macroPair#1#2{#1#2}
\newenvironment{reviewblock}{\begin{quote}}{\end{quote}}
\DeclareMathOperator{\argmax}{arg\,max}
` }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "refs.bib", content: "@article{smith2025, author={Smith}, title={A Test}}\n" }
    });
    const completionIndex = await app.inject({ method: "GET", url: `/api/projects/${project.id}/completions`, headers: { cookie } });
    expect(completionIndex.statusCode).toBe(200);
    expect(completionIndex.json().index.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "\\noindent", source: "LaTeX" }),
      expect.objectContaining({ label: "\\reviewnote", source: "paper.sty", apply: "\\reviewnote{${1}}" }),
      expect.objectContaining({ label: "\\reviewpair", source: "paper.sty", apply: "\\reviewpair{${1}}{${2}}" }),
      expect.objectContaining({ label: "\\macroPair", source: "paper.sty", apply: "\\macroPair{${1}}{${2}}" }),
      expect.objectContaining({ label: "\\argmax", source: "paper.sty" })
    ]));
    expect(completionIndex.json().index.environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "reviewblock", source: "paper.sty" }),
      expect.objectContaining({ label: "itemize", source: "LaTeX" })
    ]));
    expect(completionIndex.json().index.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "smith2025", source: "refs.bib" })
    ]));
    expect(completionIndex.json().index.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "paper.sty", source: "Project" }),
      expect.objectContaining({ label: "refs.bib", source: "Project" })
    ]));
    const configured = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { engine: "pdflatex", latexmkrc: ".latexmkrc" } });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().project.latexmkrc).toBe(".latexmkrc");
    const emptyDictionary = await app.inject({ method: "GET", url: `/api/projects/${project.id}/dictionary`, headers: { cookie } });
    expect(emptyDictionary.statusCode).toBe(200);
    expect(emptyDictionary.json()).toEqual({ words: [] });
    const addedDictionaryWord = await app.inject({ method: "POST", url: `/api/projects/${project.id}/dictionary`, headers: { cookie }, payload: { word: "LaTeX" } });
    expect(addedDictionaryWord.statusCode).toBe(201);
    expect(addedDictionaryWord.json().words).toEqual(["LaTeX"]);
    const duplicateDictionaryWord = await app.inject({ method: "POST", url: `/api/projects/${project.id}/dictionary`, headers: { cookie }, payload: { word: "latex" } });
    expect(duplicateDictionaryWord.statusCode).toBe(201);
    expect(duplicateDictionaryWord.json().words).toEqual(["LaTeX"]);
    const removedDictionaryWord = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/dictionary/${encodeURIComponent("LaTeX")}`, headers: { cookie } });
    expect(removedDictionaryWord.statusCode).toBe(200);
    expect(removedDictionaryWord.json()).toEqual({ words: [] });

    const helloOffset = source.indexOf("Hello");
    const comment = await app.inject({ method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie }, payload: { path: "main.tex", startOffset: helloOffset, endOffset: helloOffset + 5, content: "Check this heading" } });
    expect(comment.statusCode).toBe(201);
    const commentId = comment.json().comment.id;
    expect(comment.json().comment).toMatchObject({ authorUsername: "admin", authorDisplayName: "Administrator", replies: [] });
    const reply = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentId}/replies`, headers: { cookie },
      payload: { content: "Reply in this thread" }
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().reply).toMatchObject({
      authorUsername: "admin", authorDisplayName: "Administrator", content: "Reply in this thread"
    });
    const replyId = reply.json().reply.id;
    expect(new Date(reply.json().reply.createdAt).toISOString()).toBe(reply.json().reply.createdAt);
    const editedComment = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie },
      payload: { content: "Updated heading comment" }
    });
    expect(editedComment.statusCode).toBe(200);
    const editedReply = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}/replies/${replyId}`, headers: { cookie },
      payload: { content: "Updated thread reply" }
    });
    expect(editedReply.statusCode).toBe(200);
    expect(editedReply.json().reply).toMatchObject({ content: "Updated thread reply" });
    expect(new Date(editedReply.json().reply.editedAt).toISOString()).toBe(editedReply.json().reply.editedAt);
    const shiftedSource = `% preface\n${source}`;
    const shifted = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: shiftedSource } });
    expect(shifted.statusCode).toBe(200);
    expect(shifted.json().comments[0]).toMatchObject({
      startOffset: helloOffset + 10, selectedText: "Hello", startLine: 4, orphaned: false,
      content: "Updated heading comment", replies: [{ content: "Updated thread reply", authorUsername: "admin" }]
    });
    expect(new Date(shifted.json().comments[0].editedAt).toISOString()).toBe(shifted.json().comments[0].editedAt);
    const resolved = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie }, payload: { resolved: true } });
    expect(resolved.statusCode).toBe(200);
    const withoutAnchor = shiftedSource.replace("Hello", "");
    const orphaned = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: withoutAnchor } });
    expect(orphaned.json().comments[0]).toMatchObject({ orphaned: true, selectedText: "Hello" });

    const deletedReply = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/comments/${commentId}/replies/${replyId}`, headers: { cookie }
    });
    expect(deletedReply.statusCode).toBe(200);
    const deletedComment = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie }
    });
    expect(deletedComment.statusCode).toBe(200);
    const commentsAfterDelete = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(commentsAfterDelete.json().comments).toEqual([]);

    const [compiled, duplicateCompile] = await Promise.all([
      app.inject({ method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie } }),
      app.inject({ method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie } })
    ]);
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json().ok, compiled.json().log).toBe(true);
    expect(compiled.json().diagnostics).toMatchObject({ warnings: expect.any(Array), errors: [] });
    expect(compiled.headers["server-timing"]).toContain("latexmk;dur=");
    expect(compiled.json().timings).toMatchObject({
      snapshotMs: expect.any(Number), cacheSyncMs: expect.any(Number),
      latexmkMs: expect.any(Number), artifactCopyMs: expect.any(Number), requestMs: expect.any(Number)
    });
    expect(new Date(compiled.json().pdfCompiledAt).toISOString()).toBe(compiled.json().pdfCompiledAt);
    expect(duplicateCompile.json()).toMatchObject({ ok: true, runId: compiled.json().runId });
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const upToDateCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(upToDateCompile.statusCode).toBe(200);
    expect(upToDateCompile.json()).toMatchObject({ ok: true, skipped: true, runId: compiled.json().runId });
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);

    const incrementalSource = `${withoutAnchor}\n% incremental compile\n`;
    const incrementalSave = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "main.tex", content: incrementalSource }
    });
    expect(incrementalSave.statusCode).toBe(200);
    const incrementalCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(incrementalCompile.statusCode).toBe(200);
    expect(incrementalCompile.json().ok, incrementalCompile.json().log).toBe(true);
    expect(incrementalCompile.json().runId).not.toBe(compiled.json().runId);
    expect(incrementalCompile.headers["server-timing"]).toContain("cache;dur=");
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const cacheRoot = path.join(config.projectsDir, project.id, "output", ".texlite", "cache");
    expect(fs.readdirSync(cacheRoot)).toHaveLength(1);
    const targetRoot = path.join(config.projectsDir, project.id, "output", ".texlite", "targets");
    const manifestPath = path.join(targetRoot, fs.readdirSync(targetRoot)[0], "latest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({ runId: incrementalCompile.json().runId, version: 2, mainFile: "main.tex" });
    const latestCompile = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/latest`, headers: { cookie }
    });
    expect(latestCompile.json()).toMatchObject({
      pdfUrl: expect.stringContaining(`/api/projects/${project.id}/pdf`),
      pdfCompiledAt: incrementalCompile.json().pdfCompiledAt,
      latestRun: { diagnostics: { warnings: expect.any(Array), errors: expect.any(Array) } }
    });
    const artifactDirectory = path.join(config.projectsDir, project.id, "output", ".texlite", "runs", manifest.runId, "output");
    expect(fs.existsSync(path.join(artifactDirectory, manifest.pdf))).toBe(true);
    expect(fs.existsSync(path.join(artifactDirectory, manifest.synctex))).toBe(true);
    fs.writeFileSync(path.join(artifactDirectory, "main.bbl"), "\\begin{thebibliography}{1}\n\\end{thebibliography}\n");
    const artifacts = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/artifacts`, headers: { cookie } });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().artifacts).toContainEqual(expect.objectContaining({ path: "main.bbl", viewable: true }));
    const viewedArtifact = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/artifacts?path=main.bbl`, headers: { cookie }
    });
    expect(viewedArtifact.json()).toMatchObject({ path: "main.bbl", content: expect.stringContaining("thebibliography") });
    const downloadedArtifact = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/artifacts?path=main.bbl&download=1`, headers: { cookie }
    });
    expect(downloadedArtifact.statusCode).toBe(200);
    expect(downloadedArtifact.headers["content-disposition"]).toContain("attachment");
    const pdfLocation = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/sync/pdf?path=main.tex&line=4&column=1`, headers: { cookie }
    });
    expect(pdfLocation.statusCode, pdfLocation.body).toBe(200);
    expect(pdfLocation.json()).toMatchObject({ page: 1 });
    const sourceLocation = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/sync/source?page=${pdfLocation.json().page}&x=${pdfLocation.json().x}&y=${pdfLocation.json().y}`,
      headers: { cookie }
    });
    expect(sourceLocation.statusCode, sourceLocation.body).toBe(200);
    expect(sourceLocation.json()).toMatchObject({ path: "main.tex", line: 4 });
    const pdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("Paper.pdf");
    expect(pdf.headers["cache-control"]).toBe("private, max-age=60, must-revalidate");
    expect(pdf.headers["accept-ranges"]).toBe("bytes");
    expect(pdf.headers.etag).toBeTruthy();
    const versionedPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf?mainFile=main.tex&run=${manifest.runId}`, headers: { cookie }
    });
    expect(versionedPdf.statusCode).toBe(200);
    expect(versionedPdf.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const rawSource = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file/raw?path=main.tex`, headers: { cookie } });
    expect(rawSource.statusCode).toBe(200);
    expect(rawSource.headers["content-disposition"]).toContain("inline");
    expect(rawSource.rawPayload.toString()).toContain("\\documentclass");
    const cachedPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie, "if-none-match": pdf.headers.etag! }
    });
    expect(cachedPdf.statusCode).toBe(304);
    const partialPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie, range: "bytes=0-7" }
    });
    expect(partialPdf.statusCode).toBe(206);
    expect(partialPdf.headers["content-range"]).toBe(`bytes 0-7/${pdf.rawPayload.length}`);
    expect(partialPdf.rawPayload).toEqual(pdf.rawPayload.subarray(0, 8));
    const downloadedPdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf?download=1`, headers: { cookie } });
    expect(downloadedPdf.statusCode).toBe(200);
    expect(downloadedPdf.headers["cache-control"]).toBe("private, no-store");
    expect(downloadedPdf.headers["content-disposition"]).toMatch(/^attachment;.*Paper-\d{4}-\d{2}-\d{2}-\d{6}\.pdf/);
    const cleanCache = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile/clean`, headers: { cookie },
      payload: { mainFile: "main.tex", mode: "cache" }
    });
    expect(cleanCache.statusCode).toBe(200);
    expect(cleanCache.json()).toMatchObject({ ok: true, mode: "cache", retainedPdf: true });
    const afterCacheClean = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/latest?mainFile=main.tex`, headers: { cookie } });
    expect(afterCacheClean.json()).toMatchObject({ hasPdf: true, latestRun: { status: "succeeded" } });
    const cleanArtifacts = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile/clean`, headers: { cookie },
      payload: { mainFile: "main.tex", mode: "artifacts" }
    });
    expect(cleanArtifacts.statusCode).toBe(200);
    expect(cleanArtifacts.json()).toMatchObject({ ok: true, mode: "artifacts", retainedPdf: false });
    const afterArtifactClean = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/latest?mainFile=main.tex`, headers: { cookie } });
    expect(afterArtifactClean.json()).toMatchObject({ hasPdf: false, latestRun: null });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } })).statusCode).toBe(404);
  }, 40_000);

  it("compiles only the currently selected LaTeX root document", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Multiple roots" }
    });
    const projectId = created.json().project.id as string;
    const standalone = String.raw`\documentclass{article}
\begin{document}
Standalone document.
\end{document}
`;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "standalone.tex", content: standalone }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "chapter.tex", content: "\\section{A chapter}\n" }
    });

    const compiled = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie },
      payload: { mainFile: "standalone.tex" }
    });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({ ok: true, mainFile: "standalone.tex" });
    expect(compiled.json().pdfUrl).toContain("mainFile=standalone.tex");
    expect(db.prepare("SELECT main_file FROM compile_runs WHERE project_id = ?").all(projectId))
      .toEqual([{ main_file: "standalone.tex" }]);

    const [defaultLatest, standaloneLatest, project] = await Promise.all([
      app.inject({ method: "GET", url: `/api/projects/${projectId}/compile/latest?mainFile=main.tex`, headers: { cookie } }),
      app.inject({ method: "GET", url: `/api/projects/${projectId}/compile/latest?mainFile=standalone.tex`, headers: { cookie } }),
      app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } })
    ]);
    expect(defaultLatest.json()).toMatchObject({ mainFile: "main.tex", latestRun: null, hasPdf: false });
    expect(standaloneLatest.json()).toMatchObject({ mainFile: "standalone.tex", hasPdf: true, latestRun: { status: "succeeded" } });
    expect(project.json().project.mainFile).toBe("main.tex");

    const invalid = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie },
      payload: { mainFile: "chapter.tex" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID" });
  }, 30_000);

  it("returns a retryable response when a stable compile snapshot cannot be obtained", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Busy snapshot" }
    });
    const projectId = created.json().project.id as string;
    const stable = vi.spyOn(CollaborationService.prototype, "isStable").mockReturnValue(false);
    try {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie }
      });
      expect(response.statusCode).toBe(409);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.json()).toMatchObject({ code: "COMPILE_SNAPSHOT_BUSY", retryable: true });
      expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
    } finally {
      stable.mockRestore();
    }
  });

  it("creates folders and moves files and directories while preserving linked paths", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Organized" } });
    const project = created.json().project;
    const chapters = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie }, payload: { path: "chapters" }
    });
    expect(chapters.statusCode).toBe(201);
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "chapters/intro.tex", content: "Introduction\n" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "chapters/intro.tex", startOffset: 0, endOffset: 12, content: "Keep this anchor" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie }, payload: { path: "archive" }
    });
    const movedFolder = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "chapters", destinationDirectory: "archive" }
    });
    expect(movedFolder.json()).toMatchObject({ path: "archive/chapters" });
    const comments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=archive%2Fchapters%2Fintro.tex`, headers: { cookie }
    });
    expect(comments.json().comments[0]).toMatchObject({ selectedText: "Introduction" });
    const movedMain = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "main.tex", destinationDirectory: "archive/chapters" }
    });
    expect(movedMain.json()).toMatchObject({ path: "archive/chapters/main.tex" });
    const details = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(details.json().project.mainFile).toBe("archive/chapters/main.tex");
    const files = await app.inject({ method: "GET", url: `/api/projects/${project.id}/files`, headers: { cookie } });
    expect(files.json().files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([
      "archive", "archive/chapters", "archive/chapters/intro.tex", "archive/chapters/main.tex"
    ]));
  });

  it("does not overwrite same-named files during creation or upload", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "No Overwrite" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "notes.txt", content: "original" }
    });

    const duplicate = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "notes.txt", content: "replacement" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "FILE_EXISTS", path: "notes.txt" });
    const unchanged = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file?path=notes.txt`, headers: { cookie } });
    expect(unchanged.json().content).toBe("original");

    const firstUpload = multipartBody("upload.txt", Buffer.from("first"));
    const uploaded = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${firstUpload.boundary}`
      }, payload: firstUpload.body
    });
    expect(uploaded.statusCode).toBe(201);
    const secondUpload = multipartBody("upload.txt", Buffer.from("second"));
    const collision = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${secondUpload.boundary}`
      }, payload: secondUpload.body
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "FILE_EXISTS", path: "upload.txt" });
    const overwritten = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload?overwrite=1`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${secondUpload.boundary}`
      }, payload: secondUpload.body
    });
    expect(overwritten.statusCode).toBe(201);
    const uploadedContent = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file?path=upload.txt`, headers: { cookie } });
    expect(uploadedContent.json().content).toBe("second");
  });

  it("keeps project archives private to each user", async () => {
    const username = `archive-reader-${randomUUID().slice(0, 8)}`;
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "Archive Reader", password: "reader-password" }
    });
    expect(createdUser.statusCode).toBe(201);
    const readerId = createdUser.json().user.id as string;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "reader-password" } });
    expect(login.statusCode).toBe(200);
    const readerCookie = login.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Private archive" } });
    const projectId = created.json().project.id as string;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" } });

    const archivedByAdmin = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/archive`, headers: { cookie } });
    expect(archivedByAdmin.statusCode).toBe(200);
    expect(archivedByAdmin.json()).toMatchObject({ ok: true, archived: true });
    const adminActive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(adminActive.json().projects.some((project: { id: string }) => project.id === projectId)).toBe(false);
    const adminArchived = await app.inject({ method: "GET", url: "/api/projects?archived=1", headers: { cookie } });
    expect(adminArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true }));

    const readerActive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(readerActive.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: false, permission: "read" }));
    const archivedByReader = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/archive`, headers: { cookie: readerCookie } });
    expect(archivedByReader.statusCode).toBe(200);
    const readerAfterArchive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(readerAfterArchive.json().projects.some((project: { id: string }) => project.id === projectId)).toBe(false);
    const readerArchived = await app.inject({ method: "GET", url: "/api/projects?archived=true", headers: { cookie: readerCookie } });
    expect(readerArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true, permission: "read" }));

    const restoredByAdmin = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/archive`, headers: { cookie } });
    expect(restoredByAdmin.statusCode).toBe(200);
    const adminRestored = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(adminRestored.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: false }));
    const readerStillArchived = await app.inject({ method: "GET", url: "/api/projects?archived=1", headers: { cookie: readerCookie } });
    expect(readerStillArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true }));
  });

  it("paginates project lists with twenty projects per page by default", async () => {
    const prefix = `Pagination ${randomUUID().slice(0, 8)}`;
    for (let index = 1; index <= 21; index += 1) {
      const created = await app.inject({
        method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: `${prefix} ${index}` }
      });
      expect(created.statusCode).toBe(201);
    }
    const firstPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}`, headers: { cookie }
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().projects).toHaveLength(20);
    expect(firstPage.json().pagination).toMatchObject({ page: 1, pageSize: 20, total: 21, totalPages: 2 });
    const secondPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}&page=2`, headers: { cookie }
    });
    expect(secondPage.json().projects).toHaveLength(1);
    expect(secondPage.json().pagination).toMatchObject({ page: 2, pageSize: 20, total: 21, totalPages: 2 });
    const smallerPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}&page=2&pageSize=5`, headers: { cookie }
    });
    expect(smallerPage.json().projects).toHaveLength(5);
    expect(smallerPage.json().pagination).toMatchObject({ page: 2, pageSize: 5, total: 21, totalPages: 5 });
  });

  it("duplicates project sources without copying collaboration or build output", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Duplicate source" } });
    const source = created.json().project;
    const sourceContent = String.raw`\documentclass{article}
\begin{document}
Copied source.
\end{document}
`;
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: sourceContent } });
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: "assets/data.txt", content: "resource" } });
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: ".latexmkrc", content: "$silent = 1;\n" } });
    await app.inject({ method: "PATCH", url: `/api/projects/${source.id}`, headers: { cookie }, payload: { latexmkrc: ".latexmkrc", engine: "xelatex" } });
    await app.inject({
      method: "POST", url: `/api/projects/${source.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Source-only comment" }
    });

    const duplicated = await app.inject({ method: "POST", url: `/api/projects/${source.id}/duplicate`, headers: { cookie }, payload: {} });
    expect(duplicated.statusCode, duplicated.body).toBe(201);
    const copy = duplicated.json().project;
    expect(copy).toMatchObject({ name: "Duplicate source (1)", ownerUsername: "admin", mainFile: "main.tex", latexmkrc: ".latexmkrc", engine: "xelatex" });
    expect(copy.id).not.toBe(source.id);
    const copiedMain = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/file?path=main.tex`, headers: { cookie } });
    expect(copiedMain.json().content).toBe(sourceContent);
    const copiedResource = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/file?path=assets%2Fdata.txt`, headers: { cookie } });
    expect(copiedResource.json().content).toBe("resource");
    const copiedComments = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/comments?path=main.tex`, headers: { cookie } });
    expect(copiedComments.json().comments).toEqual([]);
    expect(fs.readdirSync(path.join(config.projectsDir, copy.id, "output"))).toEqual([".texlite"]);
    expect(fs.existsSync(path.join(config.projectsDir, copy.id, "output", ".texlite", "history"))).toBe(true);
  });

  it("searches included files and restores automatic project history", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "History paper" } });
    const projectId = created.json().project.id as string;
    const main = String.raw`\documentclass{article}
\begin{document}
\section{Main result}
UniqueTerm in the main document.
\input{sections/intro}
\end{document}
`;
    const intro = String.raw`\section{Introduction and
Motivation}
Another UniqueTerm appears here.
`;
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "main.tex", content: main } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "sections/intro.tex", content: intro } })).statusCode).toBe(200);

    const versions = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions.length).toBeGreaterThanOrEqual(3);
    expect(versions.json().stats).toMatchObject({
      versionCount: expect.any(Number), ordinaryVersionCount: expect.any(Number),
      objectBytes: expect.any(Number), maxVersions: 200, maxStorageBytes: 512 * 1024 * 1024
    });
    const selectedVersion = versions.json().versions[0];
    expect(selectedVersion.changedPaths).toContain("sections/intro.tex");

    const outline = await app.inject({ method: "GET", url: `/api/projects/${projectId}/outline`, headers: { cookie } });
    expect(outline.json().outline).toEqual([
      expect.objectContaining({ path: "main.tex", line: 3, title: "Main result" }),
      expect.objectContaining({ path: "sections/intro.tex", line: 1, title: "Introduction and\nMotivation" })
    ]);
    const search = await app.inject({ method: "GET", url: `/api/projects/${projectId}/search?q=UniqueTerm&wholeWord=1`, headers: { cookie } });
    expect(search.json()).toMatchObject({ total: 2, truncated: false });
    expect(search.json().matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "main.tex", line: 4, column: 1 }),
      expect.objectContaining({ path: "sections/intro.tex", line: 3, column: 9 })
    ]));

    const replaced = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/search/replace`, headers: { cookie },
      payload: { query: "UniqueTerm", replacement: "ChangedTerm", wholeWord: true }
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json()).toMatchObject({ replacements: 2, files: ["main.tex", "sections/intro.tex"] });

    const comparison = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/history/${selectedVersion.id}/file?path=main.tex`, headers: { cookie }
    });
    expect(comparison.json().historical).toContain("UniqueTerm");
    expect(comparison.json().comparison).toContain("ChangedTerm");
    const labeled = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie }, payload: { label: "Before terminology update" }
    });
    expect(labeled.json().version.label).toBe("Before terminology update");

    const restoredFile = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie }, payload: { path: "main.tex" }
    });
    expect(restoredFile.statusCode, restoredFile.body).toBe(200);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toContain("UniqueTerm");
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "sections/intro.tex"), "utf8")).toContain("ChangedTerm");

    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "transient.txt", content: "remove on restore" } });
    const restoredProject = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie }, payload: {}
    });
    expect(restoredProject.statusCode, restoredProject.body).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "transient.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "sections/intro.tex"), "utf8")).toContain("UniqueTerm");

    const suffix = randomUUID().slice(0, 8);
    const username = `history-reader-${suffix}`;
    const reader = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "History Reader", password: "reader-password" }
    });
    const readerId = reader.json().user.id as string;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" } });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "reader-password" } });
    const readerCookie = readerLogin.headers["set-cookie"]!.split(";")[0];
    const readerHistory = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie: readerCookie } });
    expect(readerHistory.statusCode).toBe(200);
    expect(readerHistory.json().stats).toBeNull();
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/search?q=UniqueTerm`, headers: { cookie: readerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie: readerCookie }, payload: { path: "main.tex" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie: readerCookie } })).statusCode).toBe(403);

    const currentBeforeDelete = fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8");
    const deletedVersion = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie } });
    expect(deletedVersion.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe(currentBeforeDelete);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie } })).statusCode).toBe(404);
    const clearedHistory = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    expect(clearedHistory.statusCode).toBe(200);
    expect(clearedHistory.json().stats).toMatchObject({ versionCount: 0, objectCount: 0, objectBytes: 0 });
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions).toEqual([]);
  });

  it("exposes operational metrics only to administrators", async () => {
    const adminMetrics = await app.inject({ method: "GET", url: "/api/health/metrics", headers: { cookie } });
    expect(adminMetrics.statusCode).toBe(200);
    expect(adminMetrics.json()).toMatchObject({
      compileQueue: { concurrency: 1 },
      collaboration: expect.objectContaining({ rooms: expect.any(Number), sessions: expect.any(Number) }),
      caches: { completions: expect.any(Object), outlines: expect.any(Object) },
      durationsMs: expect.any(Object)
    });
    const username = `metrics-user-${randomUUID().slice(0, 8)}`;
    await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie }, payload: { username, displayName: "Metrics User", password: "metrics-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "metrics-password" } });
    const userCookie = login.headers["set-cookie"]!.split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/health/metrics", headers: { cookie: userCookie } })).statusCode).toBe(403);
  });

  it("manages an owner-only encrypted GitHub backup with commit, diff, checkout and push", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Git backup paper" } });
    const projectId = created.json().project.id as string;
    const initialStatus = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git`, headers: { cookie } });
    expect(initialStatus.json().status).toMatchObject({ initialized: false, tokenConfigured: false });

    const token = "github_pat_test_token_1234567890";
    const configured = await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/git/token`, headers: { cookie }, payload: { token }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().status).toMatchObject({ initialized: true, tokenConfigured: true, githubLogin: "texlite-owner" });
    const stored = db.prepare("SELECT token_ciphertext FROM project_git_settings WHERE project_id = ?").get(projectId) as { token_ciphertext: string };
    expect(stored.token_ciphertext).not.toContain(token);
    expect(fs.statSync(path.join(root, "git-token.key")).mode & 0o777).toBe(0o600);

    const repository = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/repository`, headers: { cookie },
      payload: { name: "git-backup-paper", private: true }
    });
    expect(repository.statusCode).toBe(200);
    expect(repository.json().status).toMatchObject({ repositoryName: "git-backup-paper", defaultBranch: "main" });

    const firstCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Initial backup" }
    });
    expect(firstCommit.statusCode, firstCommit.body).toBe(201);
    expect(firstCommit.json().commit).toMatchObject({ authorName: "admin", authorEmail: "admin@texlite.com", message: "Initial backup" });
    const firstSha = firstCommit.json().commit.sha as string;

    const changedSource = String.raw`\documentclass{article}
\begin{document}
Second version.
\end{document}
`;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "main.tex", content: changedSource }
    });
    const workingDiff = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git/diff`, headers: { cookie } });
    expect(workingDiff.statusCode).toBe(200);
    expect(workingDiff.json().diff).toContain("+Second version.");
    const secondCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Second backup" }
    });
    expect(secondCommit.statusCode).toBe(201);

    const bare = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", bare]);
    await execFileAsync("git", ["remote", "set-url", "origin", bare], { cwd: sourceRoot(config, projectId) });
    const pushed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/push`, headers: { cookie } });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().status.ahead).toBe(0);

    const checkedOut = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: false }
    });
    expect(checkedOut.statusCode).toBe(200);
    expect(checkedOut.json().status.branch).toBeNull();
    const detachedCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Detached commit" }
    });
    expect(detachedCommit.statusCode).toBe(409);
    const detachedPush = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/push`, headers: { cookie } });
    expect(detachedPush.statusCode).toBe(409);
    const historicalFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(historicalFile.json().content).not.toContain("Second version.");

    const returned = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: null, force: false }
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().status.branch).toBe("main");
    const currentFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(currentFile.json().content).toContain("Second version.");

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: changedSource.replace("Second", "Discarded") }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "untracked.txt", content: "keep me" }
    });
    const discarded = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/discard`, headers: { cookie } });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json().status).toMatchObject({ dirty: true, restorable: false });
    const restoredFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(restoredFile.json().content).toContain("Second version.");
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "untracked.txt"), "utf8")).toBe("keep me");

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: changedSource.replace("Second", "Uncommitted") }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "untracked.txt", content: "temporary" }
    });
    const refused = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: false }
    });
    expect(refused.statusCode).toBe(400);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "untracked.txt"))).toBe(true);
    const forced = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: true }
    });
    expect(forced.statusCode).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "untracked.txt"))).toBe(false);

    const readerCreated = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "git-reader", displayName: "Git Reader", password: "reader-password" }
    });
    const readerId = readerCreated.json().user.id;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "edit" } });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "git-reader", password: "reader-password" } });
    const readerCookie = readerLogin.headers["set-cookie"]!.split(";")[0];
    const forbidden = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git`, headers: { cookie: readerCookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("does not grant project creation to new users by default", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "writer", displayName: "Writer", password: "writer-password" }
    });
    expect(createdUser.statusCode).toBe(201);
    expect(createdUser.json().user.canCreateProjects).toBe(false);
    expect(createdUser.json().user.mustChangePassword).toBe(false);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "writer", password: "writer-password" } });
    expect(login.json().user.mustChangePassword).toBe(false);
    const writerCookie = login.headers["set-cookie"]!.split(";")[0];
    const project = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: writerCookie }, payload: { name: "Not allowed" } });
    expect(project.statusCode).toBe(403);
    const granted = await app.inject({ method: "PATCH", url: `/api/admin/users/${createdUser.json().user.id}`, headers: { cookie }, payload: { canCreateProjects: true } });
    expect(granted.json().user.canCreateProjects).toBe(true);
    const allowed = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: writerCookie }, payload: { name: "Allowed" } });
    expect(allowed.statusCode).toBe(201);
  });

  it("allows only authors to edit or delete their comments and replies", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "comment-reader", displayName: "Comment Reader", password: "reader-password" }
    });
    const readerId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "comment-reader", password: "reader-password" }
    });
    const readerCookie = login.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Authored comments" } });
    const projectId = created.json().project.id;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" }
    });
    const beforePrivateTag = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    const readerTagResponse = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie: readerCookie },
      payload: { name: "Private review", color: "orange" }
    });
    const adminSameNameTag = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie },
      payload: { name: "Private review", color: "blue" }
    });
    expect(readerTagResponse.statusCode).toBe(201);
    expect(adminSameNameTag.statusCode).toBe(201);
    expect(readerTagResponse.json().tag.id).not.toBe(adminSameNameTag.json().tag.id);
    const readerTagged = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/tags`, headers: { cookie: readerCookie },
      payload: { tagId: readerTagResponse.json().tag.id }
    });
    expect(readerTagged.statusCode).toBe(201);
    expect(readerTagged.json().project.tags).toEqual([expect.objectContaining({ name: "Private review", color: "orange" })]);
    const readerProject = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie: readerCookie } });
    const adminProject = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(readerProject.json().project.tags).toHaveLength(1);
    expect(adminProject.json().project.tags).toEqual([]);
    expect(adminProject.json().project.updatedAt).toBe(beforePrivateTag.json().project.updatedAt);
    const readerTags = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie: readerCookie } });
    const adminTags = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie } });
    expect(readerTags.json().tags).toContainEqual(readerTagResponse.json().tag);
    expect(readerTags.json().tags).not.toContainEqual(adminSameNameTag.json().tag);
    expect(adminTags.json().tags).toContainEqual(adminSameNameTag.json().tag);
    expect(adminTags.json().tags).not.toContainEqual(readerTagResponse.json().tag);
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Administrator comment" }
    });
    const commentId = comment.json().comment.id;
    const reply = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments/${commentId}/replies`, headers: { cookie },
      payload: { content: "Administrator reply" }
    });
    const replyId = reply.json().reply.id;

    const readerComment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: readerCookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Read member comment" }
    });
    expect(readerComment.statusCode).toBe(201);
    expect(readerComment.json().comment).toMatchObject({ authorUsername: "comment-reader", content: "Read member comment" });
    const readerReply = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments/${commentId}/replies`, headers: { cookie: readerCookie },
      payload: { content: "Read member reply" }
    });
    expect(readerReply.statusCode).toBe(201);
    expect(readerReply.json().reply).toMatchObject({ authorUsername: "comment-reader", content: "Read member reply" });

    for (const request of [
      { method: "PATCH", url: `/api/projects/${projectId}/comments/${commentId}`, payload: { content: "Overwritten" } },
      { method: "DELETE", url: `/api/projects/${projectId}/comments/${commentId}` },
      { method: "PATCH", url: `/api/projects/${projectId}/comments/${commentId}/replies/${replyId}`, payload: { content: "Overwritten" } },
      { method: "DELETE", url: `/api/projects/${projectId}/comments/${commentId}/replies/${replyId}` }
    ] as const) {
      const response = await app.inject({ ...request, headers: { cookie: readerCookie } });
      expect(response.statusCode).toBe(403);
    }
    const unchanged = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=main.tex`, headers: { cookie: readerCookie }
    });
    expect(unchanged.json().comments[0]).toMatchObject({
      content: "Administrator comment", replies: [
        { content: "Administrator reply" }, { content: "Read member reply" }
      ]
    });

    const successfulRunId = randomUUID();
    const compiledAt = new Date(Date.now() - 1_000).toISOString();
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'main.tex', 'succeeded', 'Successful compile', ?, ?)`)
      .run(successfulRunId, projectId, comment.json().comment.authorId, compiledAt, compiledAt);
    const failedRunId = randomUUID();
    const failedAt = new Date().toISOString();
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'main.tex', 'failed', 'Latest compile failed', ?, ?)`)
      .run(failedRunId, projectId, comment.json().comment.authorId, failedAt, failedAt);
    const outputDirectory = path.join(config.projectsDir, projectId, "output");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.mkdirSync(path.join(outputDirectory, ".texlite"), { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, ".texlite", "latest.pdf"), "%PDF-1.4\nretained\n");
    const latestCompile = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/compile/latest`, headers: { cookie: readerCookie }
    });
    expect(latestCompile.statusCode).toBe(200);
    expect(latestCompile.json()).toMatchObject({
      hasPdf: true,
      pdfUrl: expect.stringMatching(new RegExp(`^/api/projects/${projectId}/pdf\\?mainFile=main\\.tex&run=\\d+(?:\\.\\d+)?$`)),
      latestRun: { id: failedRunId, status: "failed", log: "Latest compile failed" }
    });
    const retainedPdf = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/pdf`, headers: { cookie: readerCookie }
    });
    expect(retainedPdf.statusCode).toBe(200);
    expect(retainedPdf.headers["content-type"]).toContain("application/pdf");
  });

  it("imports ZIP projects and manages colored tags", async () => {
    const archive = makeZip({
      "paper/draft.tex": "Draft document",
      "paper/main.tex": String.raw`\documentclass{article}\begin{document}Imported\end{document}`,
      "paper/refs.bib": ""
    });
    const multipart = multipartBody("paper.zip", archive);
    const imported = await app.inject({
      method: "POST", url: "/api/projects/import?name=Imported%20Paper", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const project = imported.json().project;
    expect(project).toMatchObject({ name: "Imported Paper", mainFile: "main.tex" });
    const files = await app.inject({ method: "GET", url: `/api/projects/${project.id}/files`, headers: { cookie } });
    expect(files.json().files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["draft.tex", "main.tex", "refs.bib"]));

    const createdTag = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie }, payload: { name: "Research", color: "purple" }
    });
    expect(createdTag.statusCode).toBe(201);
    const tag = createdTag.json().tag;
    const catalog = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie } });
    expect(catalog.json().tags).toContainEqual(tag);
    const tagged = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie }, payload: { tagId: tag.id }
    });
    expect(tagged.statusCode).toBe(201);
    expect(tagged.json().tags[0]).toMatchObject({ name: "Research", color: "purple" });
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(projects.json().projects.find((item: { id: string }) => item.id === project.id)).toMatchObject({
      ownerUsername: "admin", lastModifiedUsername: "admin", tags: [{ name: "Research" }]
    });

    const renamed = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { name: "Renamed Paper" }
    });
    expect(renamed.json().project).toMatchObject({ name: "Renamed Paper", lastModifiedUsername: "admin" });
    const download = await app.inject({ method: "GET", url: `/api/projects/${project.id}/download`, headers: { cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.headers["content-disposition"]).toContain("Renamed%20Paper.zip");
    expect(download.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("deletes a project together with its source files and history", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Disposable" } });
    const project = created.json().project;
    const historyDirectory = path.join(config.projectsDir, project.id, "output", ".texlite", "history");
    expect(fs.existsSync(path.join(config.projectsDir, project.id, "source", "main.tex"))).toBe(true);
    expect(fs.existsSync(historyDirectory)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(path.join(config.projectsDir, project.id))).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(0);
    const missing = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it("allows an administrator's effective owner permission to delete another user's project", async () => {
    const suffix = randomUUID().slice(0, 8);
    const username = `admin-delete-owner-${suffix}`;
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "Admin Delete Owner", password: "owner-password", canCreateProjects: true }
    });
    const ownerId = createdUser.json().user.id as string;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "owner-password" } });
    const ownerCookie = login.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: ownerCookie }, payload: { name: "Administrator cleanup" }
    });
    const projectId = created.json().project.id as string;

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(path.join(config.projectsDir, projectId))).toBe(false);
    await app.inject({
      method: "DELETE", url: `/api/admin/users/${ownerId}`, headers: { cookie }, payload: { deleteProjects: false }
    });
  });

  it("transfers ownership while retaining the former owner as an editor", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "project-recipient", displayName: "Project Recipient", password: "recipient-password" }
    });
    const recipient = createdUser.json().user;
    expect(recipient.canCreateProjects).toBe(false);
    const recipientLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "project-recipient", password: "recipient-password" }
    });
    const recipientCookie = recipientLogin.headers["set-cookie"]!.split(";")[0];
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const formerOwnerId = me.json().user.id as string;
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Transferred paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${recipient.id}`, headers: { cookie }, payload: { permission: "read" }
    });
    const historyCount = (db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count;
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO project_git_settings
      (project_id, token_ciphertext, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(project.id, "former-owner-token", "former-owner", timestamp, timestamp);

    const transferred = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/owner`, headers: { cookie }, payload: { userId: recipient.id }
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().project.ownerId).toBe(recipient.id);
    const recipientProject = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie: recipientCookie } });
    expect(recipientProject.json().project).toMatchObject({ ownerId: recipient.id, permission: "owner" });
    expect(db.prepare("SELECT permission FROM project_members WHERE project_id = ? AND user_id = ?").get(project.id, formerOwnerId)).toEqual({ permission: "edit" });
    expect(db.prepare("SELECT permission FROM project_members WHERE project_id = ? AND user_id = ?").get(project.id, recipient.id)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(historyCount);
    expect(db.prepare("SELECT token_ciphertext, github_login FROM project_git_settings WHERE project_id = ?").get(project.id)).toEqual({
      token_ciphertext: null, github_login: null
    });
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/owner`, headers: { cookie }, payload: { userId: formerOwnerId }
    })).statusCode).toBe(403);
  });

  it("deletes a user's owned projects together with their histories", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "disposable-owner", displayName: "Disposable Owner", password: "owner-password", canCreateProjects: true }
    });
    const ownerId = createdUser.json().user.id as string;
    const ownerLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "disposable-owner", password: "owner-password" }
    });
    const ownerCookie = ownerLogin.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: ownerCookie }, payload: { name: "Delete with owner" }
    });
    const projectId = created.json().project.id as string;
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(projectId) as { count: number }).count).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(config.projectsDir, projectId, "output", ".texlite", "history"))).toBe(true);

    const deleted = await app.inject({
      method: "DELETE", url: `/api/admin/users/${ownerId}`, headers: { cookie }, payload: { deleteProjects: true }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, deletedProjects: 1 });
    expect(fs.existsSync(path.join(config.projectsDir, projectId))).toBe(false);
    expect(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
  });

  it("records the shared user who last changed project source", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "last-editor", displayName: "Last Editor", password: "editor-password" }
    });
    const editorId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "last-editor", password: "editor-password" }
    });
    const editorCookie = login.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Shared paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${editorId}`, headers: { cookie }, payload: { permission: "edit" }
    });
    const changed = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie: editorCookie },
      payload: { path: "main.tex", content: "\\documentclass{article}\n" }
    });
    expect(changed.statusCode).toBe(200);
    const details = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(details.json().project).toMatchObject({
      ownerUsername: "admin", lastModifiedUsername: "last-editor", lastModifiedDisplayName: "Last Editor"
    });
  });

  it("preserves comments and replies with a deleted-user author marker", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "former-reviewer", displayName: "Former Reviewer", password: "reviewer-password" }
    });
    const reviewerId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "former-reviewer", password: "reviewer-password" }
    });
    const reviewerCookie = login.headers["set-cookie"]!.split(";")[0];
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Reviewed paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${reviewerId}`, headers: { cookie }, payload: { permission: "read" }
    });
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie: reviewerCookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Former user comment" }
    });
    const commentId = comment.json().comment.id;
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentId}/replies`, headers: { cookie: reviewerCookie },
      payload: { content: "Former user reply" }
    });
    const deleted = await app.inject({
      method: "DELETE", url: `/api/admin/users/${reviewerId}`, headers: { cookie }, payload: { deleteProjects: false }
    });
    expect(deleted.statusCode).toBe(200);
    const comments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(comments.json().comments[0]).toMatchObject({
      authorUsername: null, authorDisplayName: null,
      replies: [{ authorUsername: null, authorDisplayName: null, content: "Former user reply" }]
    });
  });

  it("rejects ZIP path traversal", async () => {
    const multipart = multipartBody("unsafe.zip", makeZip({ "../main.tex": "unsafe" }));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(fs.existsSync(path.join(root, "main.tex"))).toBe(false);
  });

  it("rejects duplicate ZIP entries instead of replacing an extracted file", async () => {
    const multipart = multipartBody("duplicates.zip", makeZipEntries([
      ["project/main.tex", "first"], ["project/main.tex", "second"]
    ]));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("重复文件名");
  });

  it("rejects a multi-tex ZIP without a documentclass candidate", async () => {
    const multipart = multipartBody("fragments.zip", makeZip({
      "fragments/chapter.tex": "\\section{Chapter}",
      "fragments/appendix.tex": "\\section{Appendix}"
    }));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("没有找到 LaTeX 主文档");
  });

  it("does not allow the active administrator to delete itself", async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const response = await app.inject({ method: "DELETE", url: `/api/admin/users/${me.json().user.id}`, headers: { cookie }, payload: { deleteProjects: true } });
    expect(response.statusCode).toBe(400);
  });
});

function multipartBody(filename: string, file: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----texlite-test-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function makeZip(entries: Record<string, string>): Buffer {
  return makeZipEntries(Object.entries(entries));
}

function makeZipEntries(entries: Array<[string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [nameText, contentText] of entries) {
    const name = Buffer.from(nameText);
    const content = Buffer.from(contentText);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
