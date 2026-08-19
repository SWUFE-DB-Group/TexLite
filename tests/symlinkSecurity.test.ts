import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import type { DatabaseConnection, ProjectRow } from "../src/server/db.js";
import { listProjectFiles, listProjectFilesAsync, resolveSourcePath } from "../src/server/files.js";
import { ProjectGitService } from "../src/server/git.js";

const execFileAsync = promisify(execFile);

describe("project source symlink protection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects symlinks in path resolution and directory listings", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-symlink-"));
    roots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    const outside = path.join(root, "outside.txt");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(outside, "must not be exposed");
    fs.symlinkSync(outside, path.join(source, "leak.txt"));

    expect(() => resolveSourcePath(config, projectId, "leak.txt")).toThrowError(/符号链接/);
    expect(() => listProjectFiles(config, projectId)).toThrowError(/符号链接/);
    await expect(listProjectFilesAsync(config, projectId)).rejects.toThrow(/符号链接/);

    fs.rmSync(path.join(source, "leak.txt"));
    fs.mkdirSync(path.join(root, "outside-dir"));
    fs.writeFileSync(path.join(root, "outside-dir", "secret.txt"), "must not be exposed");
    fs.symlinkSync(path.join(root, "outside-dir"), path.join(source, "assets"), "dir");
    expect(() => resolveSourcePath(config, projectId, "assets/secret.txt")).toThrowError(/符号链接/);
  });

  it("refuses a Git revision containing a tracked symlink before checkout", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-git-symlink-"));
    roots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    const outside = path.join(root, "outside.txt");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(outside, "private host data");
    await runGit(source, ["init", "-q"]);
    await runGit(source, ["checkout", "-q", "-B", "main"]);
    await runGit(source, ["config", "user.name", "TexLite test"]);
    await runGit(source, ["config", "user.email", "test@texlite.com"]);
    fs.writeFileSync(path.join(source, "main.tex"), "safe\n");
    await runGit(source, ["add", "main.tex"]);
    await runGit(source, ["-c", "commit.gpgSign=false", "commit", "-qm", "safe"]);
    fs.symlinkSync(outside, path.join(source, "leak.txt"));
    await runGit(source, ["add", "leak.txt"]);
    await runGit(source, ["-c", "commit.gpgSign=false", "commit", "-qm", "unsafe"]);
    const unsafeRevision = await runGit(source, ["rev-parse", "HEAD"]);
    await runGit(source, ["reset", "--hard", "HEAD~1"]);

    const database = { prepare: () => ({ get: () => undefined }) } as unknown as DatabaseConnection;
    const service = new ProjectGitService(config, database);
    const project = { id: projectId } as ProjectRow;
    await expect(service.checkout(project, unsafeRevision, false)).rejects.toMatchObject({
      code: "SYMLINK_FORBIDDEN", statusCode: 409
    });
    expect(fs.lstatSync(path.join(source, "leak.txt"), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(outside, "utf8")).toBe("private host data");

    await runGit(source, ["checkout", "-q", "--force", unsafeRevision]);
    await expect(service.status(project)).rejects.toMatchObject({ code: "SYMLINK_FORBIDDEN", statusCode: 409 });
  });
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

function testConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "admin@example.test",
    host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 3, latexmk: "latexmk", defaultEngine: "pdflatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
    maxUploadBytes: 50 * 1024 * 1024, historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
