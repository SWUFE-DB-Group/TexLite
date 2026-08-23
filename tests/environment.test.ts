import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { assertEnvironment, assertGitAvailable } from "../src/server/environment.js";

function testConfig(): Config {
  const root = path.join(os.tmpdir(), "texlite-environment-test");
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "",
    host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "db.sqlite"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: process.execPath, defaultEngine: "xelatex",
    allowedEngines: [], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
    git: process.execPath, gitOperationTimeoutMs: 10_000, githubApiBaseUrl: "https://api.github.com"
  };
}

describe("startup environment checks", () => {
  it("requires LaTeX commands but treats Git as an on-demand dependency", async () => {
    const config = testConfig();
    const available = await assertEnvironment({ ...config, git: "/definitely/missing/texlite-git" });
    expect(available).toHaveLength(1);
    expect(available[0].version).toMatch(/^v\d+/);
    await expect(assertEnvironment({ ...config, latexmk: "/definitely/missing/texlite-latexmk" }))
      .rejects.toThrow("Initialization/startup has been stopped");
    await expect(assertGitAvailable({ ...config, git: "/definitely/missing/texlite-git" }))
      .rejects.toMatchObject({ code: "GIT_UNAVAILABLE", statusCode: 503 });
  });
});
