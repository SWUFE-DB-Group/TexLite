import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectHostRequirements } from "../src/server/environment.js";
import { HarperService } from "../src/server/harper.js";

describe.runIf(process.env.TEXLITE_TEST_NATIVE_HOST_TOOLS === "1")("native host tools", () => {
  it("recognizes native executables as optional tools", async () => {
    const tools = await inspectHostRequirements();
    for (const id of ["git", "harper-cli", "pdffonts"]) {
      expect(tools.find((tool) => tool.id === id), id).toMatchObject({ requirement: "optional", status: "installed" });
    }
  }, 20_000);

  it("gets spelling diagnostics from Harper with a Unicode temporary path and CRLF LaTeX", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "TexLite Harper 论文 "));
    const harper = new HarperService();
    vi.stubEnv("TEMP", directory);
    vi.stubEnv("TMP", directory);
    vi.stubEnv("TMPDIR", directory);
    try {
      const source = "\\section{Writing}\r\n% 中文 😀 hidden typpo\r\nThis sentence has wrng prose.\r\n";
      const lints = await harper.lint(source, "main.tex");
      const spelling = lints.find((lint) => lint.problem === "wrng");
      expect(spelling).toMatchObject({ start: [...source.slice(0, source.indexOf("wrng"))].length });
      expect(lints.map((lint) => lint.problem)).not.toContain("typpo");
    } finally {
      await harper.dispose();
      vi.unstubAllEnvs();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 40_000);
});
