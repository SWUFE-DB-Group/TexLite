// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTikzFigurePdf } from "../src/client/workspace/useTikzFigurePdf";

describe("saving a TikZ figure as a PDF", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ReturnType<typeof useTikzFigurePdf>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const compile = vi.fn();
  const onError = vi.fn();
  const exports = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/compile/export-pdf"));

  function Probe({ projectId = "p", projectEngine = "xelatex" as const, allowedEngines }: { projectId?: string; projectEngine?: "xelatex"; allowedEngines?: Array<"pdflatex" | "lualatex"> }) {
    current = useTikzFigurePdf({ projectId, userId: "u", projectEngine, allowedEngines, compile, onError });
    return null;
  }
  const render = (props: Parameters<typeof Probe>[0] = {}) => act(async () => root.render(createElement(Probe, props)));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    compile.mockReset(); onError.mockReset();
    fetchMock = vi.fn(async () => Response.json({ path: "figs/arch.pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("saves only after this figure compiled successfully", async () => {
    await render();
    for (const result of [null, { ok: false, mainFile: "figs/arch.tex" }, { ok: true, cancelled: true, mainFile: "figs/arch.tex" }, { ok: true, mainFile: "main.tex" }]) {
      compile.mockResolvedValueOnce(result);
      await act(async () => current.run("figs/arch.tex"));
      expect(current.state).toBeNull();
    }
    expect(exports()).toHaveLength(0);

    compile.mockResolvedValueOnce({ ok: true, mainFile: "figs/arch.tex" });
    await act(async () => current.run("figs/arch.tex"));
    expect(exports()).toHaveLength(1);
    expect(current.state).toEqual({ path: "figs/arch.tex", status: "saved", file: "arch.pdf" });
  });

  it("reports a failed save", async () => {
    await render();
    compile.mockResolvedValueOnce({ ok: true, mainFile: "a.tex" });
    fetchMock.mockResolvedValueOnce(Response.json({ code: "SERVER_ERROR" }, { status: 500 }));
    await act(async () => current.run("a.tex"));
    expect(onError).toHaveBeenCalledOnce();
    expect(current.state).toBeNull();
  });

  it("starts from the project's engine and remembers the choice per project", async () => {
    await render();
    expect(current.engine).toBe("xelatex");
    await act(async () => current.setEngine("lualatex"));
    compile.mockResolvedValueOnce(null);
    await act(async () => current.run("a.tex"));
    expect(compile).toHaveBeenCalledWith("lualatex");

    await render({ projectId: "other" });
    expect(current.engine).toBe("xelatex");
    await render({ projectId: "p" });
    expect(current.engine).toBe("lualatex");
    // An engine the administrator has since disallowed is not offered.
    await render({ projectId: "p", allowedEngines: ["pdflatex"] });
    expect(current.engine).toBe("pdflatex");
  });
});
