import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
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
      maxUploadBytes: 50 * 1024 * 1024
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
    const unauthenticated = await app.inject({ method: "GET", url: "/api/projects" });
    expect(unauthenticated.statusCode).toBe(401);
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({ siteName: "Test texLite", adminEmail: "admin@example.test" });
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
      expect.objectContaining({ label: "\\reviewnote", source: "paper.sty" }),
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
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(2);
    const cacheRoot = path.join(config.projectsDir, project.id, "output", ".texlite", "cache");
    expect(fs.readdirSync(cacheRoot)).toHaveLength(1);
    const manifestPath = path.join(config.projectsDir, project.id, "output", ".texlite", "latest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({ runId: incrementalCompile.json().runId, version: 1 });
    const latestCompile = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/latest`, headers: { cookie }
    });
    expect(latestCompile.json()).toMatchObject({
      pdfUrl: expect.stringContaining(`/api/projects/${project.id}/pdf`),
      pdfCompiledAt: incrementalCompile.json().pdfCompiledAt
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
    expect(pdf.headers["cache-control"]).toBe("private, no-cache");
    expect(pdf.headers["accept-ranges"]).toBe("bytes");
    expect(pdf.headers.etag).toBeTruthy();
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
    expect(downloadedPdf.headers["content-disposition"]).toMatch(/^attachment;.*Paper-\d{4}-\d{2}-\d{2}-\d{6}\.pdf/);
  }, 40_000);

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
      (id, project_id, requested_by, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'succeeded', 'Successful compile', ?, ?)`)
      .run(successfulRunId, projectId, comment.json().comment.authorId, compiledAt, compiledAt);
    const failedRunId = randomUUID();
    const failedAt = new Date().toISOString();
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'failed', 'Latest compile failed', ?, ?)`)
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
      hasPdf: true, pdfUrl: `/api/projects/${projectId}/pdf?run=${successfulRunId}`,
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

  it("deletes a project and its source files", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Disposable" } });
    const project = created.json().project;
    expect(fs.existsSync(path.join(config.projectsDir, project.id, "source", "main.tex"))).toBe(true);
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(path.join(config.projectsDir, project.id))).toBe(false);
    const missing = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
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
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [nameText, contentText] of Object.entries(entries)) {
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
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
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
