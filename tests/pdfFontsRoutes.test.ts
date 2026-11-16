import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app";
import { openDatabase, type DatabaseConnection } from "../src/server/db";
import { createSessionToken } from "../src/server/security";
import { captureCompileSnapshot, publishCompileArtifacts } from "../src/server/compiler";
import { sourceRoot } from "../src/server/files";
import { inspectPdfFonts } from "../src/server/pdfFonts";
import { httpError } from "../src/server/http";
import { createTestConfig } from "./helpers/testConfig";

vi.mock("../src/server/pdfFonts", () => ({ inspectPdfFonts: vi.fn() }));
const font = { name: "ABC+Example", type: "Type 3", encoding: "Custom", embedded: true, subset: true, unicode: false };

describe("PDF font routes", () => {
  let root: string, app: FastifyInstance, db: DatabaseConnection, projectId: string, otherProjectId: string;
  let run: string, oldRun: string, otherRun: string, alternateRun: string;
  const cookies = new Map<string, string>();
  const config = () => createTestConfig(root, { basePath: "/texlite" });
  const request = (runId = run, mainFile = "main.tex", user = "owner", target = projectId) => app.inject({ method: "GET",
    url: `/texlite/api/projects/${target}/compile/fonts?${new URLSearchParams({ run: runId, mainFile })}`, headers: { cookie: cookies.get(user) ?? "" } });
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-pdf-fonts-")); db = openDatabase(config());
    const time = new Date().toISOString();
    for (const id of ["owner", "reader", "outsider"]) {
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, must_change_password, created_at)
        VALUES (?, ?, ?, 'hash', 'user', 1, 0, ?)`).run(id, id, id, time);
      const session = createSessionToken();
      db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, '2099-01-01', ?)").run(session.digest, id, time);
      cookies.set(id, `texlite_session=${session.token}`);
    }
    app = await buildApp(config(), db, { logger: false });
    const create = async () => {
      const response = await app.inject({ method: "POST", url: "/texlite/api/projects", headers: { cookie: cookies.get("owner")! }, payload: { name: "Font test" } });
      expect(response.statusCode).toBe(201);
      const id = response.json().project.id;
      fs.writeFileSync(path.join(sourceRoot(config(), id), "main.tex"), "\\documentclass{article}\\begin{document}Text\\end{document}");
      return id as string;
    };
    projectId = await create(); otherProjectId = await create();
    db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, 'reader', 'read', ?)").run(projectId, time);
    const publish = async (id: string, mainFile = "main.tex") => {
      const runId = randomUUID();
      db.prepare(`INSERT INTO compile_runs (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
        VALUES (?, ?, 'owner', ?, 'succeeded', '', ?, ?)`).run(runId, id, mainFile, time, time);
      const snapshot = await captureCompileSnapshot(config(), id, runId, { mainFile, engine: "pdflatex", latexmkrc: null, extraArgs: [] });
      const pdfPath = path.join(snapshot.outputDir, "main.pdf"); fs.writeFileSync(pdfPath, "%PDF-1.4\nfixture");
      publishCompileArtifacts(config(), id, snapshot, { ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath, synctexPath: null });
      return runId;
    };
    oldRun = await publish(projectId); run = await publish(projectId); otherRun = await publish(otherProjectId);
    fs.mkdirSync(path.join(sourceRoot(config(), projectId), "sub"));
    fs.copyFileSync(path.join(sourceRoot(config(), projectId), "main.tex"), path.join(sourceRoot(config(), projectId), "sub/main.tex"));
    alternateRun = await publish(projectId, "sub/main.tex");
  });
  beforeEach(() => { vi.mocked(inspectPdfFonts).mockReset().mockResolvedValue({ fonts: [font], hasWarnings: false }); });
  afterAll(async () => { await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("checks the requested immutable PDF, including retained runs and read-only members, not the latest failed log", async () => {
    const failed = randomUUID(), time = new Date(Date.now() + 1000).toISOString();
    db.prepare(`INSERT INTO compile_runs (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
      VALUES (?, ?, 'owner', 'main.tex', 'failed', 'failed', ?, ?)`).run(failed, projectId, time, time);
    const result = await request(oldRun, "main.tex", "reader");
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ mainFile: "main.tex", runId: oldRun, fonts: [font], hasWarnings: false });
    expect(inspectPdfFonts).toHaveBeenCalledWith(expect.stringContaining(`${oldRun}${path.sep}output${path.sep}main.pdf`), expect.any(AbortSignal));
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect((await request(failed)).statusCode).toBe(404);
  });

  it("rejects unauthorized access, other project/root runs, missing files and run traversal before invoking a command", async () => {
    expect((await request(run, "main.tex", "anonymous")).statusCode).toBe(401);
    expect((await request(run, "main.tex", "outsider")).statusCode).toBe(404);
    for (const id of [otherRun, alternateRun, "../private", randomUUID(), ""]) expect((await request(id)).statusCode).toBe(404);
    expect((await request(run, "../main.tex")).statusCode).toBe(400);
    expect((await request(run, "missing.tex")).statusCode).toBe(400);
    expect(inspectPdfFonts).not.toHaveBeenCalled();
  });

  it("returns a localized optional-tool message and allows retry without changing compilation", async () => {
    vi.mocked(inspectPdfFonts).mockRejectedValueOnce(httpError(503, "PDF_FONTS_UNAVAILABLE"));
    const response = await app.inject({ method: "GET", url: `/texlite/api/projects/${projectId}/compile/fonts?run=${run}`, headers: { cookie: cookies.get("owner")!, "accept-language": "zh-Hant" } });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe("PDF_FONTS_UNAVAILABLE");
    expect(response.json().error).toContain("字型");
    expect((await request()).statusCode).toBe(200);
    expect(db.prepare("SELECT status FROM compile_runs WHERE id = ?").get(run)).toEqual({ status: "succeeded" });
  });

  it("rechecks access before returning results when membership is revoked mid-inspection", async () => {
    vi.mocked(inspectPdfFonts).mockImplementationOnce(async () => {
      db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = 'reader'").run(projectId);
      return { fonts: [font], hasWarnings: false };
    });
    try { expect((await request(run, "main.tex", "reader")).statusCode).toBe(404); }
    finally { db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, 'reader', 'read', ?)").run(projectId, new Date().toISOString()); }
  });
});
