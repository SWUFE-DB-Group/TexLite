import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("configuration", () => {
  const originalConfig = process.env.TEXLITE_CONFIG;
  let root = "";

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.TEXLITE_CONFIG;
    else process.env.TEXLITE_CONFIG = originalConfig;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves data paths relative to the config file", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-config-"));
    const configPath = path.join(root, "texlite.config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      siteName: "Lab TeX",
      adminEmail: "latex@example.test",
      storage: { dataDir: "data" },
      uploads: { maxFileSizeMB: 25 },
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
    expect(config.git).toBe("/usr/local/bin/git");
    expect(config.gitOperationTimeoutMs).toBe(45_000);
    expect(config.githubApiBaseUrl).toBe("https://github.example/api/v3");
  });
});
