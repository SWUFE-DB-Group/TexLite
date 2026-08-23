import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("configuration", () => {
  const envKeys = [
    "TEXLITE_CONFIG", "TEXLITE_SITE_NAME", "TEXLITE_ADMIN_EMAIL", "TEXLITE_HOST", "TEXLITE_PORT",
    "TEXLITE_DATA_DIR", "TEXLITE_CLIENT_DIR", "TEXLITE_SESSION_DAYS", "TEXLITE_COMPILE_TIMEOUT",
    "TEXLITE_MAX_COMPILE_JOBS", "TEXLITE_LATEXMK", "TEXLITE_DEFAULT_ENGINE", "TEXLITE_MAX_UPLOAD_SIZE_MB",
    "TEXLITE_PDF_LOADING_STRATEGY", "TEXLITE_PDF_RANGE_THRESHOLD_MB",
    "TEXLITE_HISTORY_MAX_VERSIONS", "TEXLITE_HISTORY_MAX_STORAGE_MB",
    "TEXLITE_GIT", "TEXLITE_GIT_TIMEOUT", "TEXLITE_GITHUB_API_URL"
  ] as const;
  const originalEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  let root = "";

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("resolves data paths relative to the config file", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      siteName: "Lab TeX",
      adminEmail: "latex@example.test",
      storage: { dataDir: "data" },
      uploads: { maxFileSizeMB: 25 },
      pdf: { loadingStrategy: "range", rangeThresholdMB: 7 },
      history: { maxVersions: 120, maxStorageMB: 256 },
      git: { binary: "/usr/local/bin/git", operationTimeoutSeconds: 45, githubApiBaseUrl: "https://github.example/api/v3/" },
      latex: { defaultEngine: "lualatex", allowedEngines: ["lualatex"], allowProjectLatexmkrc: false }
    }));
    process.env.TEXLITE_CONFIG = configPath;
    const config = loadConfig();
    expect(config.siteName).toBe("Lab TeX");
    expect(config.dataDir).toBe(path.join(root, "data"));
    expect(config.defaultEngine).toBe("lualatex");
    expect(config.allowedEngines).toEqual(["lualatex"]);
    expect(config.allowProjectLatexmkrc).toBe(false);
    expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(config.pdfLoadingStrategy).toBe("range");
    expect(config.pdfRangeThresholdBytes).toBe(7 * 1024 * 1024);
    expect(config.historyMaxVersions).toBe(120);
    expect(config.historyMaxStorageBytes).toBe(256 * 1024 * 1024);
    expect(config.git).toBe("/usr/local/bin/git");
    expect(config.gitOperationTimeoutMs).toBe(45_000);
    expect(config.githubApiBaseUrl).toBe("https://github.example/api/v3");
  });

  it("uses TexLite as the default site name", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-default-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({}));
    process.env.TEXLITE_CONFIG = configPath;
    process.env.TEXLITE_DATA_DIR = path.join(root, "data");
    delete process.env.TEXLITE_SITE_NAME;
    const config = loadConfig();
    expect(config).toMatchObject({
      siteName: "TexLite", host: "127.0.0.1", port: 3000, sessionDays: 14,
      compileTimeoutMs: 600_000, maxCompileJobs: 10, defaultEngine: "xelatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"], maxUploadBytes: 50 * 1024 * 1024,
      pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 120_000, githubApiBaseUrl: "https://api.github.com"
    });
  });

  it("rejects invalid limits instead of silently restoring a default", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-limit-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ latex: { compileTimeoutSeconds: 0 } }));
    process.env.TEXLITE_CONFIG = configPath;
    expect(() => loadConfig()).toThrow(/latex\.compileTimeoutSeconds.*1 to 3600/);
  });

  it("validates history retention limits", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-history-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ history: { maxVersions: 9, maxStorageMB: 15 } }));
    process.env.TEXLITE_CONFIG = configPath;
    expect(() => loadConfig()).toThrow(/history\.maxVersions.*10 to 5000/);
  });

  it("validates the PDF loading strategy and range threshold", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-pdf-"));
    const configPath = path.join(root, "texlite.config.json");
    process.env.TEXLITE_CONFIG = configPath;
    fs.writeFileSync(configPath, JSON.stringify({ pdf: { loadingStrategy: "sometimes" } }));
    expect(() => loadConfig()).toThrow(/pdf\.loadingStrategy.*auto, full, range/);
    fs.writeFileSync(configPath, JSON.stringify({ pdf: { rangeThresholdMB: 0 } }));
    expect(() => loadConfig()).toThrow(/pdf\.rangeThresholdMB.*1 to 2048/);
  });

  it("rejects invalid environment overrides with the variable context", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-env-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, "{}");
    process.env.TEXLITE_CONFIG = configPath;
    process.env.TEXLITE_MAX_COMPILE_JOBS = "many";
    expect(() => loadConfig()).toThrow(/latex\.maxCompileJobs.*many/);
  });

  it("rejects an engine list that omits the selected default", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-engine-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ latex: { defaultEngine: "xelatex", allowedEngines: ["pdflatex"] } }));
    process.env.TEXLITE_CONFIG = configPath;
    expect(() => loadConfig()).toThrow(/latex\.allowedEngines.*xelatex/);
  });

  it("reports a data path that is a file", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-invalid-path-"));
    const blocked = path.join(root, "not-a-directory");
    fs.writeFileSync(blocked, "file");
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ storage: { dataDir: "not-a-directory" } }));
    process.env.TEXLITE_CONFIG = configPath;
    expect(() => loadConfig()).toThrow(/storage\.dataDir.*points to a file/);
  });
});
