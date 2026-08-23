import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, escapeGlobPattern } from "../src/server/app.js";
import { CollaborationService } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";
import { sourceRoot } from "../src/server/files.js";

function citationPayload(citationKey: string, title: string, bibtex: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { bibtex, citationKey, entryType: "article", title, authors: null, year: "2026", ...extras };
}

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

  it("revokes cookies when an account is disabled, including after re-enabling it", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "disable-cookie-user", displayName: "Disable Cookie User", password: "reader-password" }
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "disable-cookie-user", password: "reader-password" }
    });
    expect(login.statusCode).toBe(200);
    const oldCookie = login.headers["set-cookie"]!.split(";")[0];
    const userId = created.json().user.id as string;
    expect((await app.inject({
      method: "PATCH", url: `/api/admin/users/${userId}`, headers: { cookie }, payload: { disabled: true }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/api/admin/users/${userId}`, headers: { cookie }, payload: { disabled: false }
    })).statusCode).toBe(200);
    const stale = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie } });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: "AUTH_REQUIRED" });
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

    // Modifying project tags touches updated_at, but does not invalidate the fast compile skip
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie },
      payload: { name: "NewTag", color: "blue" }
    });
    const metadataChangedCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(metadataChangedCompile.statusCode).toBe(200);
    expect(metadataChangedCompile.json()).toMatchObject({ ok: true, skipped: true, runId: compiled.json().runId });
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

    // A retained PDF must remain available while a collaboration room is
    // still warming up. Any project queue would call waitForReady and fail
    // this request, making a cold restart unnecessarily slow.
    const originalWaitForReady = CollaborationService.prototype.waitForReady;
    CollaborationService.prototype.waitForReady = async () => {
      throw new Error("PDF serving must not wait for collaboration readiness");
    };
    try {
      const coldStartPdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } });
      expect(coldStartPdf.statusCode).toBe(200);
    } finally {
      CollaborationService.prototype.waitForReady = originalWaitForReady;
    }
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
    const renamedMain = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "archive/chapters/main.tex", destinationDirectory: "archive/chapters", destinationName: "paper.tex" }
    });
    expect(renamedMain.json()).toMatchObject({ path: "archive/chapters/paper.tex" });
    const renamedFolder = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "archive/chapters", destinationDirectory: "archive", destinationName: "sections" }
    });
    expect(renamedFolder.json()).toMatchObject({ path: "archive/sections" });
    const details = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(details.json().project.mainFile).toBe("archive/sections/paper.tex");
    const files = await app.inject({ method: "GET", url: `/api/projects/${project.id}/files`, headers: { cookie } });
    expect(files.json().files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([
      "archive", "archive/sections", "archive/sections/intro.tex", "archive/sections/paper.tex"
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

  it("reanchors source comments when an uploaded text file replaces the source", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Upload comment anchors" } });
    const projectId = created.json().project.id as string;
    const original = "first line\nkeep this sentence\nlast line\n";
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: original }
    })).statusCode).toBe(200);
    const selected = "keep this sentence";
    const startOffset = original.indexOf(selected);
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset, endOffset: startOffset + selected.length, content: "Review this sentence" }
    });
    expect(comment.statusCode).toBe(201);

    const replacement = "inserted line\nfirst line\nkeep this sentence\nlast line\n";
    const multipart = multipartBody("main.tex", Buffer.from(replacement));
    const uploaded = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/upload?overwrite=1`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(uploaded.statusCode).toBe(201);
    const comments = await app.inject({ method: "GET", url: `/api/projects/${projectId}/comments?path=main.tex`, headers: { cookie } });
    expect(comments.json().comments[0]).toMatchObject({ selectedText: selected, startOffset: replacement.indexOf(selected), orphaned: false });
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

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "restore-target.txt", content: "restore me" }
    });
    const restoreVersions = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    const restoreVersion = restoreVersions.json().versions.find((version: { changedPaths: string[] }) => version.changedPaths.includes("restore-target.txt"));
    expect(restoreVersion).toBeTruthy();
    await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=restore-target.txt`, headers: { cookie } });
    await app.inject({ method: "POST", url: `/api/projects/${projectId}/folders`, headers: { cookie }, payload: { path: "restore-target.txt" } });
    const versionsBeforeConflict = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions.length;
    const targetConflict = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${restoreVersion.id}/restore`, headers: { cookie }, payload: { path: "restore-target.txt" }
    });
    expect(targetConflict.statusCode).toBe(409);
    expect(targetConflict.json()).toMatchObject({ code: "HISTORY_TARGET_CONFLICT" });
    const versionsAfterConflict = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions.length;
    expect(versionsAfterConflict).toBe(versionsBeforeConflict);
    expect(fs.readdirSync(sourceRoot(config, projectId)).some((entry) => entry.startsWith("restore-target.txt.history-") && entry.endsWith(".tmp"))).toBe(false);

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

    // Add a comment to the project
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Draft note" }
    });

    const tagged = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie }, payload: { tagId: tag.id }
    });
    expect(tagged.statusCode).toBe(201);
    expect(tagged.json().tags[0]).toMatchObject({ name: "Research", color: "purple" });
    expect(tagged.json().project).toMatchObject({ commentCount: 1, unresolvedCommentCount: 1 });
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(projects.json().projects.find((item: { id: string }) => item.id === project.id)).toMatchObject({
      ownerUsername: "admin", lastModifiedUsername: "admin", tags: [{ name: "Research" }],
      commentCount: 1, unresolvedCommentCount: 1
    });

    const renamed = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { name: "Renamed Paper" }
    });
    expect(renamed.json().project).toMatchObject({
      name: "Renamed Paper", lastModifiedUsername: "admin",
      commentCount: 1, unresolvedCommentCount: 1
    });

    const untagged = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/tags/${tag.id}`, headers: { cookie }
    });
    expect(untagged.statusCode).toBe(200);
    expect(untagged.json().project).toMatchObject({
      commentCount: 1, unresolvedCommentCount: 1
    });

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

  it("does not delete database record if moving project directory to trash fails", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Fail Delete Project" }
    });
    const projectId = created.json().project.id as string;
    expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(1);

    const originalRename = fs.renameSync.bind(fs);
    const originalRm = fs.rmSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(oldPath).includes(projectId)) throw Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" });
      return originalRename(oldPath, newPath);
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      if (String(targetPath).includes(projectId)) throw Object.assign(new Error("simulated EPERM"), { code: "EPERM" });
      return originalRm(targetPath, options as any);
    });

    try {
      const deleteAttempt = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } });
      expect(deleteAttempt.statusCode).toBe(500);
      // Verify DB record is preserved
      expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(1);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }

    // Now normal deletion succeeds
    const successfulDelete = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(successfulDelete.statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(0);
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

    // Add a comment to the project
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Transfer note" }
    });

    const transferred = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/owner`, headers: { cookie }, payload: { userId: recipient.id }
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().project.ownerId).toBe(recipient.id);
    expect(transferred.json().project).toMatchObject({ commentCount: 1, unresolvedCommentCount: 1 });
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

  it("validates project mainFile and allows temporarily having no main file", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Main File Validation" } });
    const project = created.json().project;
    expect(project.mainFile).toBe("main.tex");

    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "alt.tex", content: "\\documentclass{article}\n\\begin{document}Alt\\end{document}\n" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "refs.bib", content: "@article{sample, title={Sample}}\n" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie },
      payload: { path: "chapters" }
    });

    // 1. Changing mainFile to a valid existing .tex file succeeds
    const updateValid = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "alt.tex" }
    });
    expect(updateValid.statusCode).toBe(200);
    expect(updateValid.json().project.mainFile).toBe("alt.tex");

    // 2. Changing mainFile to empty string / null fails with 400 MAIN_FILE_INVALID
    const updateEmpty = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "" }
    });
    expect(updateEmpty.statusCode).toBe(400);
    expect(updateEmpty.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 3. Changing mainFile to a non-.tex file fails with 400 MAIN_FILE_INVALID
    const updateNonTex = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "refs.bib" }
    });
    expect(updateNonTex.statusCode).toBe(400);
    expect(updateNonTex.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 4. Changing mainFile to a directory fails with 400 MAIN_FILE_INVALID
    const updateDirectory = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "chapters" }
    });
    expect(updateDirectory.statusCode).toBe(400);
    expect(updateDirectory.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 5. Changing mainFile to a non-existent .tex file fails with 400 MAIN_FILE_NOT_FOUND
    const updateMissing = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "missing.tex" }
    });
    expect(updateMissing.statusCode).toBe(400);
    expect(updateMissing.json()).toMatchObject({ code: "MAIN_FILE_NOT_FOUND" });

    // 6. Changing latexmkrc to a directory fails with 400 LATEXMKRC_INVALID
    const updateRcDir = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { latexmkrc: "chapters" }
    });
    expect(updateRcDir.statusCode).toBe(400);
    expect(updateRcDir.json()).toMatchObject({ code: "LATEXMKRC_INVALID" });
  });

  it("escapes SQL LIKE special characters when filtering projects by search term", async () => {
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "paper_draft_v1" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "paperXdraftXv1" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "accuracy 100%" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "accuracy 1000" }
    });

    const searchUnderscore = await app.inject({
      method: "GET", url: "/api/projects?search=paper_draft", headers: { cookie }
    });
    expect(searchUnderscore.statusCode).toBe(200);
    const underscoreNames = searchUnderscore.json().projects.map((p: any) => p.name);
    expect(underscoreNames).toContain("paper_draft_v1");
    expect(underscoreNames).not.toContain("paperXdraftXv1");

    const searchPercent = await app.inject({
      method: "GET", url: "/api/projects?search=100%", headers: { cookie }
    });
    expect(searchPercent.statusCode).toBe(200);
    const percentNames = searchPercent.json().projects.map((p: any) => p.name);
    expect(percentNames).toContain("accuracy 100%");
    expect(percentNames).not.toContain("accuracy 1000");
  });

  it("batches and groups comment replies without N+1 query failures", async () => {
    const createProject = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Comment Batch Test" }
    });
    const project = createProject.json().project;

    const comment1Res = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Comment 1" }
    });
    const comment1 = comment1Res.json().comment;

    const comment2Res = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 6, endOffset: 10, content: "Comment 2" }
    });
    const comment2 = comment2Res.json().comment;

    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment1.id}/replies`, headers: { cookie },
      payload: { content: "Reply 1.1" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment1.id}/replies`, headers: { cookie },
      payload: { content: "Reply 1.2" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment2.id}/replies`, headers: { cookie },
      payload: { content: "Reply 2.1" }
    });

    const getComments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(getComments.statusCode).toBe(200);
    const comments = getComments.json().comments;
    expect(comments).toHaveLength(2);

    const c1 = comments.find((c: any) => c.id === comment1.id);
    expect(c1.replies).toHaveLength(2);
    expect(c1.replies.map((r: any) => r.content)).toEqual(["Reply 1.1", "Reply 1.2"]);

    const c2 = comments.find((c: any) => c.id === comment2.id);
    expect(c2.replies).toHaveLength(1);
    expect(c2.replies[0].content).toBe("Reply 2.1");
  });

  it("exposes unresolvedCommentCount and commentCount on project lists and details", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Comment Count Project" }
    });
    const projectId = created.json().project.id as string;

    // Add 2 comments: 1 resolved, 1 unresolved
    const commentRes1 = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Unresolved comment" }
    });
    expect(commentRes1.statusCode).toBe(201);
    const commentRes2 = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "To be resolved" }
    });
    expect(commentRes2.statusCode).toBe(201);
    const comment2 = commentRes2.json().comment;
    await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/comments/${comment2.id}`, headers: { cookie },
      payload: { resolved: true }
    });

    // Check project detail endpoint
    const detailRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}`, headers: { cookie }
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().project).toMatchObject({
      unresolvedCommentCount: 1,
      commentCount: 2
    });

    // Check project list endpoint
    const listRes = await app.inject({
      method: "GET", url: `/api/projects?search=Comment%20Count%20Project`, headers: { cookie }
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().projects.find((p: any) => p.id === projectId);
    expect(listed).toMatchObject({
      unresolvedCommentCount: 1,
      commentCount: 2
    });

    // Create a companion file and a directory file with comments
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "sections/intro.tex", content: "Introduction section" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "sections/intro.tex", startOffset: 0, endOffset: 5, content: "Intro comment" }
    });

    const withSectionRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(withSectionRes.json().project).toMatchObject({ unresolvedCommentCount: 2, commentCount: 3 });

    // Delete sections directory
    const deleteRes = await app.inject({
      method: "DELETE", url: `/api/projects/${projectId}/file?path=sections`, headers: { cookie }
    });
    expect(deleteRes.statusCode).toBe(200);

    // Comments for sections/intro.tex should be deleted from DB and project summary updated
    const afterDeleteRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(afterDeleteRes.json().project).toMatchObject({ unresolvedCommentCount: 1, commentCount: 2 });

    const commentsForDeleted = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=sections%2Fintro.tex`, headers: { cookie }
    });
    expect(commentsForDeleted.json().comments).toHaveLength(0);
  });

  it("escapes SQLite GLOB special characters when cleaning up comments on file deletion", async () => {
    expect(escapeGlobPattern("dir[1]")).toBe("dir[[]1]");
    expect(escapeGlobPattern("doc*name?")).toBe("doc[*]name[?]");

    const createProjectRes = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "GLOB Comment Project" }
    });
    const projectId = createProjectRes.json().project.id;

    // Create two directories: dir1 and dir[1]
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "dir1/note.tex", content: "dir1 content" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "dir[1]/note.tex", content: "dir[1] content" }
    });

    // Add comments to both
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "dir1/note.tex", startOffset: 0, endOffset: 4, content: "dir1 comment" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "dir[1]/note.tex", startOffset: 0, endOffset: 6, content: "dir[1] comment" }
    });

    const beforeDelete = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(beforeDelete.json().project).toMatchObject({ commentCount: 2 });

    // Delete dir[1]
    const deleteRes = await app.inject({
      method: "DELETE", url: `/api/projects/${projectId}/file?path=dir%5B1%5D`, headers: { cookie }
    });
    expect(deleteRes.statusCode).toBe(200);

    // dir1 comment should NOT be deleted
    const dir1Comments = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=dir1%2Fnote.tex`, headers: { cookie }
    });
    expect(dir1Comments.json().comments).toHaveLength(1);

    // dir[1] comment should be deleted
    const dirBracketComments = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=dir%5B1%5D%2Fnote.tex`, headers: { cookie }
    });
    expect(dirBracketComments.json().comments).toHaveLength(0);

    const afterDelete = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(afterDelete.json().project).toMatchObject({ commentCount: 1 });
  });

  it("handles unexpected server exceptions with a generic 500 SERVER_ERROR response", async () => {
    const testApp = await buildApp(config, db, { logger: false });
    testApp.get("/api/test-unexpected-error", async () => {
      throw new TypeError("Simulated internal runtime null dereference error");
    });
    await testApp.ready();

    const response = await testApp.inject({
      method: "GET",
      url: "/api/test-unexpected-error"
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({
      code: "SERVER_ERROR",
      error: "服务器内部错误"
    });
    expect(body.error).not.toContain("Simulated internal runtime");
    await testApp.close();
  });

  it("rate limits repeated failed login attempts with 429 AUTH_RATE_LIMITED", async () => {
    const testUsername = "ratelimit-target";
    await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: testUsername, displayName: "Rate Limit Target", password: "correct-password-123" }
    });

    // 5 consecutive bad passwords
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: testUsername, password: "wrong-password" }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("AUTH_INVALID");
    }

    // 5th bad attempt triggers lockout
    const fifthRes = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: testUsername, password: "wrong-password" }
    });
    expect(fifthRes.statusCode).toBe(429);
    expect(fifthRes.json().code).toBe("AUTH_RATE_LIMITED");

    // Even with the correct password, it is locked out
    const lockedRes = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: testUsername, password: "correct-password-123" }
    });
    expect(lockedRes.statusCode).toBe(429);
    expect(lockedRes.json().code).toBe("AUTH_RATE_LIMITED");
  });

  it("returns HTTP 400 for safeRelativePath and short password validation errors", async () => {
    const projectRes = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Error Handling Test Project" }
    });
    const projectId = projectRes.json().project.id;

    // Invalid relative path should return 400 INVALID_PATH
    const invalidPathRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/file/raw?path=..%2Fsecret`, headers: { cookie }
    });
    expect(invalidPathRes.statusCode).toBe(400);
    expect(invalidPathRes.json().code).toBe("INVALID_PATH");

    // Reserved .git path should return 400 RESERVED_PATH
    const reservedPathRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/file/raw?path=.git%2Fconfig`, headers: { cookie }
    });
    expect(reservedPathRes.statusCode).toBe(400);
    expect(reservedPathRes.json().code).toBe("RESERVED_PATH");

    // Short password (< 8 chars) on user creation should return 400 PASSWORD_TOO_SHORT
    const shortPasswordRes = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "short-pass-user", displayName: "Short", password: "123" }
    });
    expect(shortPasswordRes.statusCode).toBe(400);
    expect(shortPasswordRes.json().code).toBe("PASSWORD_TOO_SHORT");
  });

  it("keeps citation updates explicit and prevents stale writes", async () => {
    const tagResponse = await app.inject({
      method: "POST", url: "/api/citations/tags", headers: { cookie },
      payload: { name: "Unassigned citation tag", color: "purple" }
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().tag.id as string;
    const tagsBeforeAssignment = await app.inject({ method: "GET", url: "/api/citations/tags", headers: { cookie } });
    expect(tagsBeforeAssignment.json().tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tagId, name: "Unassigned citation tag" })
    ]));

    const created = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Original", "@article{versioned2026, title={Original}, year={2026}}")
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().entry.revision).toBe(1);
    const entryId = created.json().entry.id as string;

    const duplicate = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Accidental replacement", "@article{versioned2026, title={Accidental replacement}, year={2026}}")
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("CITATION_KEY_EXISTS");

    const lookup = await app.inject({
      method: "POST", url: "/api/citations/lookup", headers: { cookie },
      payload: { keys: ["VERSIONED2026", "missing"] }
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().matches).toEqual([
      expect.objectContaining({ id: entryId, citationKey: "versioned2026", revision: 1 })
    ]);

    const tagged = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}/tags`, headers: { cookie },
      payload: { tagIds: [tagId], expectedRevision: 1 }
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().entry).toMatchObject({ revision: 2, bibtex: "@article{versioned2026, title={Original}, year={2026}}" });

    const staleEdit = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}`, headers: { cookie },
      payload: citationPayload("versioned2026", "Stale", "@article{versioned2026, title={Stale}, year={2026}}", { expectedRevision: 1 })
    });
    expect(staleEdit.statusCode).toBe(409);
    expect(staleEdit.json().code).toBe("CITATION_CONFLICT");

    const edited = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}`, headers: { cookie },
      payload: citationPayload("versioned2026", "Edited safely", "@article{versioned2026, title={Edited safely}, year={2026}}", { expectedRevision: 2 })
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().entry).toMatchObject({ revision: 3, title: "Edited safely" });
    expect(edited.json().entry.tags).toEqual([expect.objectContaining({ id: tagId })]);

    const staleTags = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}/tags`, headers: { cookie },
      payload: { tagIds: [], expectedRevision: 2 }
    });
    expect(staleTags.statusCode).toBe(409);
    const explicitOverwrite = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Updated from a project", "@article{versioned2026, title={Updated from a project}, year={2026}}", {
        overwrite: true, expectedRevision: 3
      })
    });
    expect(explicitOverwrite.statusCode).toBe(200);
    expect(explicitOverwrite.json()).toMatchObject({ updated: true, entry: { revision: 4, title: "Updated from a project" } });
    expect(explicitOverwrite.json().entry.tags).toEqual([expect.objectContaining({ id: tagId })]);
    const stored = await app.inject({ method: "GET", url: "/api/citations?q=versioned2026", headers: { cookie } });
    expect(stored.json().entries[0]).toMatchObject({ revision: 4, title: "Updated from a project" });
    expect(stored.json().entries[0].tags).toEqual([expect.objectContaining({ id: tagId })]);

    expect((await app.inject({ method: "DELETE", url: `/api/citations/${entryId}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/citations/tags/${tagId}`, headers: { cookie } })).statusCode).toBe(200);
  });

  it("keeps citation libraries private per user", async () => {
    const tagResponse = await app.inject({
      method: "POST", url: "/api/citations/tags", headers: { cookie },
      payload: { name: "Security papers", color: "blue" }
    });
    expect(tagResponse.statusCode).toBe(201);
    const citationResponse = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("shared2026", "Shared paper", "@article{shared2026, title={Shared paper}, author={Author}, year={2026}}", { authors: "Author", tagIds: [tagResponse.json().tag.id] })
    });
    expect(citationResponse.statusCode).toBe(201);
    expect(citationResponse.json().entry.tags).toEqual([expect.objectContaining({ name: "Security papers", color: "blue" })]);
    const ownLibrary = await app.inject({ method: "GET", url: "/api/citations", headers: { cookie } });
    expect(ownLibrary.json().pagination).toEqual({ page: 1, pageSize: 60, total: 1, totalPages: 1 });
    expect((await app.inject({ method: "PATCH", url: "/api/citations/settings", headers: { cookie }, payload: { visibility: "public" } })).statusCode).toBe(403);

    const readerCreated = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "citation-reader", displayName: "Citation Reader", password: "reader-pass-123" }
    });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "citation-reader", password: "reader-pass-123" } });
    const readerCookie = readerLogin.headers["set-cookie"]!.split(";")[0];
    const readerLibrary = await app.inject({ method: "GET", url: "/api/citations", headers: { cookie: readerCookie } });
    expect(readerLibrary.statusCode).toBe(200);
    expect(readerLibrary.json().entries).toHaveLength(0);
    expect(readerLibrary.json().pagination).toEqual({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
    expect((await app.inject({ method: "GET", url: "/api/citations/tags", headers: { cookie: readerCookie } })).json().tags).toHaveLength(0);
    const unauthorizedEdit = await app.inject({
      method: "PATCH", url: `/api/citations/${citationResponse.json().entry.id}`, headers: { cookie: readerCookie },
      payload: { bibtex: "@article{hijack, title={No}}" }
    });
    expect(unauthorizedEdit.statusCode).toBe(404);
    const readerCitation = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie: readerCookie },
      payload: citationPayload("reader2026", "Reader paper", "@article{reader2026, title={Reader paper}, author={Reader}, year={2026}}", { authors: "Reader" })
    });
    expect(readerCitation.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/citations", headers: { cookie: readerCookie } })).json().entries)
      .toEqual([expect.objectContaining({ citationKey: "reader2026", ownerUsername: "citation-reader" })]);
    expect((await app.inject({ method: "GET", url: "/api/citations", headers: { cookie } })).json().entries)
      .toEqual([expect.objectContaining({ citationKey: "shared2026", ownerUsername: "admin" })]);
    expect(readerCreated.statusCode).toBe(201);
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
