import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { assertEnvironment } from "../src/server/environment.js";

function testConfig(): Config {
  const root = path.join(os.tmpdir(), "texlite-environment-test");
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "",
    host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "db.sqlite"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: process.execPath, defaultEngine: "xelatex",
    allowedEngines: [], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024,
    git: process.execPath, gitOperationTimeoutMs: 10_000, githubApiBaseUrl: "https://api.github.com"
  };
}

describe("startup environment checks", () => {
  it("checks configured commands and stops on a missing dependency", async () => {
    const available = await assertEnvironment(testConfig());
    expect(available).toHaveLength(1);
    expect(available[0].version).toMatch(/^v\d+/);
    await expect(assertEnvironment({ ...testConfig(), git: "/definitely/missing/texlite-git" }))
      .rejects.toThrow("初始化/启动已停止");
  });
});
