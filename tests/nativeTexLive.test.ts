import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncArtifacts } from "../src/server/compileArtifacts.js";
import { captureCompileSnapshot, compileProject, publishCompileArtifacts } from "../src/server/compiler.js";
import { pdfToSource, sourceToPdf } from "../src/server/synctex.js";
import { createTestConfig } from "./helpers/testConfig.js";

const engines = ["pdflatex", "xelatex", "lualatex"] as const;
const chapter = "chapters/Part One 论文.tex";

describe.runIf(process.env.TEXLITE_TEST_NATIVE_TEXLIVE === "1")("native TeX Live compilation", () => {
  let root: string;
  let config: ReturnType<typeof createTestConfig>;
  let projectId: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "TexLite 论文 "));
    // Keep LuaLaTeX's font cache in the disposable compile working directory.
    vi.stubEnv("TEXMFCACHE", ".");
    config = createTestConfig(root, { allowedEngines: [...engines] });
    projectId = randomUUID();
    source = path.join(config.projectsDir, projectId, "source");
    await fs.mkdir(path.join(source, "chapters"), { recursive: true });
    await fs.writeFile(path.join(source, chapter), "A marker in the chapter.\n");
    await fs.writeFile(path.join(source, "main.tex"), [
      String.raw`\documentclass{article}`,
      String.raw`\begin{document}`,
      "A marker in the main document.",
      String.raw`\clearpage`,
      `\\input{"${chapter}"}`,
      String.raw`\end{document}`,
      ""
    ].join("\n"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function snapshot(engine: typeof engines[number], latexmkrc: string | null = null) {
    return captureCompileSnapshot(config, projectId, randomUUID(), { mainFile: "main.tex", engine, latexmkrc, extraArgs: [] });
  }

  it.each(engines)("publishes a reused %s PDF and jumps in both directions", async (engine) => {
    const first = await snapshot(engine);
    const initial = await compileProject(config, first, "main.tex", engine, null);
    expect(initial.ok, initial.log).toBe(true);
    publishCompileArtifacts(config, projectId, first, initial);

    const second = await snapshot(engine);
    const cached = await compileProject(config, second, "main.tex", engine, null);
    expect(cached.ok, cached.log).toBe(true);
    expect(cached.log).toMatch(/nothing to do/i);
    publishCompileArtifacts(config, projectId, second, cached);
    const artifact = syncArtifacts(config, projectId, "main.tex", second.runId);
    expect(artifact).toEqual({ source: second.sourceDir, pdf: cached.pdfPath, synctex: cached.synctexPath });
    expect(artifact?.pdf).toBeTruthy();
    expect(artifact?.synctex).toBeTruthy();

    for (const [file, line, page] of [["main.tex", 3, 1], [chapter, 1, 2]] as const) {
      const pdf = await sourceToPdf(artifact!.source, artifact!.pdf, file, line, 1);
      expect(pdf, file).toMatchObject({ page });
      const restored = await pdfToSource(artifact!.source, artifact!.pdf, page, pdf!.x + 1, pdf!.y - 1);
      expect(path.relative(second.sourceDir, restored.input).split(path.sep).join("/")).toBe(file);
      expect(restored.line).toBe(line);
    }
  }, 65_000);

  it("locates a failed TeX command in the included source", async () => {
    await fs.writeFile(path.join(source, chapter), "% comment\n\\TexLiteFixtureUndefined\n");
    const run = await snapshot("xelatex");
    const result = await compileProject(config, run, "main.tex", "xelatex", null);
    expect(result.ok, result.log).toBe(false);
    expect(result.diagnostics.errors, result.log).toContainEqual(expect.objectContaining({
      phase: "xelatex", file: expect.stringContaining(chapter), line: 2, message: "Undefined control sequence."
    }));
    expect(syncArtifacts(config, projectId, "main.tex", run.runId)).toBeNull();
  }, 35_000);

  it("cancels a running latexmk before it can publish anything", async () => {
    const marker = "texlite-cancel-ready";
    const rc = "test.latexmkrc";
    // A test-only project rc blocks in latexmk itself after signaling readiness.
    await fs.writeFile(path.join(source, rc), `open(my $ready, '>', '${marker}') or die $!;\nclose($ready);\nsleep 15;\n`);
    const run = await snapshot("xelatex", rc);
    const controller = new AbortController();
    const compile = compileProject(config, run, "main.tex", "xelatex", rc, { signal: controller.signal });
    const output = path.join(config.projectsDir, projectId, "output");
    const started = (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !controller.signal.aborted) {
        const entries = await fs.readdir(output, { recursive: true });
        if (entries.some((entry) => path.basename(entry) === marker)) return true;
        await delay(50);
      }
      return false;
    })();
    try {
      expect(await Promise.race([started, compile.then(() => false)])).toBe(true);
      controller.abort();
      expect(await compile).toMatchObject({ ok: false, cancelled: true, pdfPath: null });
      expect(syncArtifacts(config, projectId, "main.tex", run.runId)).toBeNull();
    } finally {
      controller.abort();
      await started;
      await compile;
    }
  }, 35_000);
});
