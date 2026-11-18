import { createTestConfig } from "./helpers/testConfig";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { assertEnvironment, assertGitAvailable, hostRequirementsSatisfied, inspectCompilerEnvironment, inspectHostEnvironment, inspectHostRequirements, type EnvironmentTool } from "../src/server/environment.js";

function testConfig(): Config {
  const root = path.join(os.tmpdir(), "texlite-environment-test");
  return createTestConfig(root, { databasePath: path.join(root, "db.sqlite"), latexmk: process.execPath, allowedEngines: ["pdflatex", "xelatex", "lualatex"], maxUploadBytes: 1024, git: process.execPath, gitOperationTimeoutMs: 10_000 });
}

describe("startup environment checks", () => {
  it("checks all compiler engines and honors the configured latexmk executable", async () => {
    const tools = await inspectCompilerEnvironment(testConfig());
    expect(tools.find(({ id }) => id === "latexmk")).toMatchObject({ command: process.execPath, status: "installed", version: process.version });
    expect(tools.map(({ id }) => id)).toEqual(["texlive", "pdflatex", "xelatex", "lualatex", "latexmk", "bibtex", "biber", "texcount", "chktex"]);
    expect(tools.every(({ requirement }) => requirement === "optional")).toBe(true);
  });

  it("requires every allowed engine at startup, but no unlisted engine or optional Git", async () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-engine-probe-"));
    const install = (engine: string) => {
      if (process.platform === "win32") fs.copyFileSync(process.execPath, path.join(tools, engine + ".exe"));
      else fs.symlinkSync(process.execPath, path.join(tools, engine));
    };
    vi.stubEnv("PATH", tools);
    try {
      const config = createTestConfig(tools, { latexmk: process.execPath, git: path.join(tools, "missing-git") });
      install("xelatex");
      expect((await assertEnvironment(config)).map((item) => item.name)).toEqual(["Node.js 24+", "latexmk", "xelatex"]);
      const multiEngineConfig: Config = { ...config, allowedEngines: ["xelatex", "pdflatex"] };
      await expect(assertEnvironment(multiEngineConfig)).rejects.toThrow(/could not run the pdflatex command/);
      install("pdflatex");
      expect((await assertEnvironment(config)).map((item) => item.name)).toEqual(["Node.js 24+", "latexmk", "xelatex"]);
      expect((await assertEnvironment(multiEngineConfig)).map((item) => item.name))
        .toEqual(["Node.js 24+", "latexmk", "xelatex", "pdflatex"]);
      await expect(assertEnvironment({ ...config, latexmk: path.join(tools, "missing-latexmk") }))
        .rejects.toThrow(/could not run the latexmk command/);
      await expect(assertGitAvailable(config)).rejects.toMatchObject({ code: "GIT_UNAVAILABLE", statusCode: 503 });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tools, { recursive: true, force: true });
    }
  });

  it("reports optional host tools without making them startup requirements", async () => {
    const tools = await inspectHostEnvironment({ ...testConfig(), git: "/definitely/missing/texlite-git" });
    expect(tools.find((tool) => tool.id === "node")).toMatchObject({ requirement: "required", status: "installed" });
    expect(tools.find((tool) => tool.id === "engine:xelatex")).toMatchObject({ requirement: "required" });
    expect(tools.find((tool) => tool.id === "engine:pdflatex")).toMatchObject({ requirement: "required" });
    expect(tools.find((tool) => tool.id === "git")).toMatchObject({ requirement: "optional", status: "missing" });
    expect(tools.find((tool) => tool.id === "texcount")).toMatchObject({ requirement: "optional", purpose: "Word and character statistics" });
    expect(tools.find((tool) => tool.id === "pdffonts")).toMatchObject({ requirement: "optional", purpose: "PDF font diagnostics" });
    expect(tools.find((tool) => tool.id === "harper-ls")).toMatchObject({ requirement: "optional" });
  });

  it("can inspect default host requirements without reading configuration", async () => {
    const tools = await inspectHostRequirements();
    const engines = tools.filter((tool) => tool.requirement === "one-of");
    expect(engines.map((tool) => tool.command)).toEqual(["pdflatex", "xelatex", "lualatex"]);
    expect(engines.every((tool) => tool.requirementGroup === "latex-engine")).toBe(true);

    const installed = (id: string, requirement: EnvironmentTool["requirement"], requirementGroup?: string): EnvironmentTool => ({
      id, name: id, command: id, requirement, requirementGroup, purpose: "test", status: "installed", version: "test", detail: null
    });
    const missingEngine = { ...installed("xelatex", "one-of", "latex-engine"), status: "missing" as const };
    expect(hostRequirementsSatisfied([installed("node", "required"), missingEngine])).toBe(false);
    expect(hostRequirementsSatisfied([installed("node", "required"), installed("xelatex", "one-of", "latex-engine")])).toBe(true);
  });
});
