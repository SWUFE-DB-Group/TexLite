import { describe, expect, it, vi } from "vitest";
import { CompilerVersionService } from "../src/server/compilerVersions.js";
import type { EnvironmentTool } from "../src/server/environment.js";
import { COMPILER_VERSION_TOOLS } from "../src/shared/compilerVersions.js";

function tool(id: string, version: string | null, status: EnvironmentTool["status"] = "installed"): EnvironmentTool {
  return { id, name: id, command: `/private/bin/${id}`, requirement: "optional", purpose: "Test", status, version, detail: "private diagnostic" };
}

describe("compiler software versions", () => {
  it("extracts concise versions without console punctuation, paths or probe details", async () => {
    const service = new CompilerVersionService(async () => [
      tool("texlive", "TeX Live (https://tug.org/texlive) version 2026"),
      tool("pdflatex", "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)"),
      tool("xelatex", "XeTeX 3.141592653-2.6-0.999997 (TeX Live 2026)"),
      tool("lualatex", "This is LuaHBTeX, Version 1.21.0 (TeX Live 2026)"),
      tool("latexmk", "Latexmk, John Collins, 15 June 2025. Version 4.87."),
      tool("bibtex", "BibTeX 0.99d (TeX Live 2026)"),
      tool("biber", "biber version: 2.21"),
      tool("texcount", "TeXcount version 3.1.1, 2018 Oct 28."),
      tool("chktex", "ChkTeX v1.7.9 - Copyright 1995-96")
    ]);
    expect(await service.getVersions()).toEqual({ tools: [
      { id: "texlive", version: "2026" },
      { id: "pdflatex", version: "3.141592653-2.6-1.40.29" },
      { id: "xelatex", version: "3.141592653-2.6-0.999997" },
      { id: "lualatex", version: "1.21.0" },
      { id: "latexmk", version: "4.87" },
      { id: "bibtex", version: "0.99d" },
      { id: "biber", version: "2.21" },
      { id: "texcount", version: "3.1.1" },
      { id: "chktex", version: "1.7.9" }
    ] });
  });

  it("infers TeX Live from engines when tlmgr is absent, but not from other distributions", async () => {
    const service = new CompilerVersionService(async () => [
      tool("texlive", null, "missing"),
      tool("pdflatex", "pdfTeX 3.141592653-2.6-1.40.28 (TeX Live 2025/Debian)")
    ]);
    expect((await service.getVersions()).tools[0]).toEqual({ id: "texlive", version: "2025" });
    const other = new CompilerVersionService(async () => [tool("pdflatex", "MiKTeX-pdfTeX 4.22 (MiKTeX 25.12)")]);
    expect((await other.getVersions()).tools[0].version).toBeNull();
  });

  it("represents missing, failed and unrecognizable versions as unknown", async () => {
    const service = new CompilerVersionService(async () => [
      tool("pdflatex", "fake 1.2", "failed"), tool("latexmk", null, "missing"), tool("biber", "available")
    ]);
    const result = await service.getVersions();
    expect(result.tools).toEqual(COMPILER_VERSION_TOOLS.map(({ id }) => ({ id, version: null })));
    expect(JSON.stringify(result)).not.toMatch(/private|command|detail/);
  });

  it("coalesces simultaneous checks, caches for one minute and refreshes on demand", async () => {
    let now = 0;
    const probe = vi.fn(async () => [tool("latexmk", "Version 4.87")]);
    const service = new CompilerVersionService(probe, () => now);
    const first = service.getVersions();
    const second = service.getVersions();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    now = 59_999;
    await service.getVersions();
    expect(probe).toHaveBeenCalledTimes(1);
    now = 60_000;
    await service.getVersions();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("recovers from a failed probe after cache expiry", async () => {
    let now = 0;
    const probe = vi.fn<() => Promise<EnvironmentTool[]>>()
      .mockRejectedValueOnce(new Error("host details"))
      .mockResolvedValueOnce([tool("latexmk", "Version 4.87")]);
    const service = new CompilerVersionService(probe, () => now);
    expect((await service.getVersions()).tools.every(({ version }) => version === null)).toBe(true);
    now = 60_000;
    expect((await service.getVersions()).tools.find(({ id }) => id === "latexmk")?.version).toBe("4.87");
  });
});
