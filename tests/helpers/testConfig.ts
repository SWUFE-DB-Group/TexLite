import path from "node:path";
import type { Config } from "../../src/server/config.js";

/**
 * A complete server configuration rooted in a temporary directory. Tests pass
 * only the settings they depend on, so adding a configuration field needs a
 * default here rather than an edit in every test file.
 */
export function createTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath: path.join(root, "texlite.db"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), tikzGalleryEnabled: false, tikzGalleryDir: path.join(root, "tikz-gallery"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
    allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
    editHistoryMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxSegments: 20_000,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false,
    ...overrides
  };
}
