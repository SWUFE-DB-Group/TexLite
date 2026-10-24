// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import type { Project } from "../src/client/types";
import { useProjectCompilation, type LatestCompileResponse } from "../src/client/workspace/useProjectCompilation";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("react-i18next", async (importOriginal) => {
  const t = (key: string) => key;
  return { ...await importOriginal<typeof import("react-i18next")>(), useTranslation: () => ({ t }) };
});

type Options = Parameters<typeof useProjectCompilation>[0];
type CompileResult = LatestCompileResponse & { runId: string; ok: boolean; skipped?: boolean; log: string; diagnostics: { warnings: []; errors: [] } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function result(runId = "new-run", ok = true): CompileResult {
  const log = ok ? "Compiled successfully." : "Compilation failed.";
  return {
    mainFile: "main.tex", runId, ok, log, diagnostics: { warnings: [], errors: [] },
    latestRun: { id: runId, status: ok ? "succeeded" : "failed", log, diagnostics: { warnings: [], errors: [] } },
    pdfUrl: ok ? `/pdf?run=${runId}` : null, pdfCompiledAt: null, pdfSizeBytes: 1234, pdfLoadingMode: "full"
  };
}
const sharedState = (runId = "new-run", status: "succeeded" | "failed" = "succeeded"): NonNullable<Options["sharedState"]> => ({
  mainFile: "main.tex", runId, status, requestedBy: { id: "owner", name: "Owner", username: "owner" }, updatedAt: "2026-10-24T00:00:00Z"
});

let root: Root, container: HTMLDivElement, options: Options;
let current: ReturnType<typeof useProjectCompilation>;
let latest: LatestCompileResponse;
let post: ReturnType<typeof deferred<CompileResult>>;
let compilePromise: Promise<void>;

function Harness(props: Options) { current = useProjectCompilation(props); return null; }
async function render(overrides: Partial<Options> = {}) {
  options = { ...options, ...overrides };
  await act(async () => { root.render(createElement(Harness, options)); });
}
const requests = (suffix: string) => vi.mocked(api).mock.calls.filter(([url]) => url.includes(suffix));
async function prepare() {
  await render();
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  current.pdfDisplayed("/pdf?run=old-run");
  vi.mocked(api).mockClear();
}
async function startCompile() {
  await act(async () => { compilePromise = current.compile(); });
}
async function finishCompile(value = result()) {
  await act(async () => { post.resolve(value); await compilePromise; });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latest = result("old-run"); post = deferred<CompileResult>();
  vi.mocked(api).mockReset().mockImplementation(async (url, init) => {
    if (url.includes("/compile/latest")) return latest;
    if (url.includes("/compile/artifacts")) return { artifacts: [] };
    if (url.endsWith("/compile") && init?.method === "POST") return post.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const project: Project = {
    id: "paper", name: "Paper", ownerId: "owner", mainFile: "main.tex", latexmkrc: null,
    engine: "pdflatex", icon: null, chktexEnabled: false, permission: "owner", tags: [],
    lastModifiedBy: null, createdAt: "", updatedAt: ""
  };
  options = {
    projectId: "paper", project, mainFile: "main.tex", collaborationSynced: true, pdfVisible: true,
    sharedState: null, onSharedState: vi.fn(), save: vi.fn(async () => true), loadOutline: vi.fn(async () => {}),
    onPreviewTab: vi.fn(), onError: vi.fn(), onCompileStart: vi.fn(), onCompileSuccess: vi.fn(), onPdfChanged: vi.fn()
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("compile completion and PDF priority", () => {
  it.each([true, false])("uses the local POST instead of refetching the shared completion (ok=%s)", async (ok) => {
    await prepare(); await startCompile();
    await render({ sharedState: sharedState("new-run", ok ? "succeeded" : "failed") });
    expect(requests("/compile/latest")).toHaveLength(0);
    await finishCompile(result("new-run", ok));
    expect(requests("/compile/latest")).toHaveLength(0);
    expect(current.compileOutcome).toBe(ok ? "succeeded" : "failed");
    expect(current.compileLog).toBe(ok ? "Compiled successfully." : "Compilation failed.");
    expect(options.onCompileSuccess).toHaveBeenCalledTimes(ok ? 1 : 0);
  });

  it("ignores a delayed WebSocket replay after the local result has already been applied", async () => {
    await prepare(); await startCompile(); await finishCompile();
    await render({ sharedState: sharedState() });
    expect(requests("/compile/latest")).toHaveLength(0);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("recovers a lost local response through the shared completion", async () => {
    await prepare(); await startCompile(); latest = result();
    await render({ sharedState: sharedState() });
    await act(async () => { post.reject(new Error("Network lost")); await compilePromise; });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
    expect(current.compileOutcome).toBe("succeeded");
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("cancels a previous shared lookup without leaving the local result in a loading state", async () => {
    await prepare();
    const lookup = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => lookup.promise);
    await render({ sharedState: sharedState("previous-run") });
    expect(current.pdfLoading).toBe(true);
    const signal = requests("/compile/latest")[0][1]?.signal;
    await startCompile();
    expect(signal?.aborted).toBe(true);
    latest = result();
    await render({ sharedState: sharedState() });
    await finishCompile();
    expect(current.pdfLoading).toBe(false);
    await act(async () => lookup.resolve(result("previous-run")));
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
    expect(current.pdfLoading).toBe(false);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("still fetches collaborators' results and applies a completed run only once", async () => {
    await prepare(); latest = result();
    await render({ sharedState: sharedState() });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
    await render({ sharedState: { ...sharedState(), updatedAt: "later" } });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("waits for the new PDF's first paint before refreshing artifacts", async () => {
    await prepare(); await startCompile(); await finishCompile();
    expect(requests("/compile/artifacts")).toHaveLength(0);
    await act(async () => current.pdfDisplayed("/pdf?run=old-run"));
    expect(requests("/compile/artifacts")).toHaveLength(0);
    await act(async () => current.pdfDisplayed("/pdf?run=new-run"));
    expect(requests("/compile/artifacts")).toHaveLength(1);
    await act(async () => current.pdfDisplayed("/pdf?run=new-run"));
    expect(requests("/compile/artifacts")).toHaveLength(1);
  });

  it("ignores an initial artifact scan that completes after a new PDF has been published", async () => {
    const scan = deferred<{ artifacts: { path: string; size: number; viewable: boolean }[] }>();
    const apiImplementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((url, init) => url.includes("/compile/artifacts")
      ? scan.promise : apiImplementation(url, init));
    await prepare();
    vi.mocked(api).mockImplementation(apiImplementation);
    await startCompile(); await finishCompile();
    await act(async () => scan.resolve({ artifacts: [{ path: "old.log", size: 100, viewable: true }] }));
    expect(current.artifacts).toEqual([]);
    await act(async () => current.pdfDisplayed("/pdf?run=new-run"));
    expect(requests("/compile/artifacts")).toHaveLength(1);
    expect(current.artifacts).toEqual([]);
  });

  it("does not wait for a hidden or failed PDF when the output panel is opened", async () => {
    await prepare(); await startCompile(); await finishCompile();
    await render({ pdfVisible: false });
    expect(requests("/compile/artifacts")).toHaveLength(1);
  });

  it("refreshes artifacts immediately when the PDF panel is already hidden", async () => {
    await prepare(); await render({ pdfVisible: false });
    await startCompile(); await finishCompile();
    expect(requests("/compile/artifacts")).toHaveLength(1);
  });

  it("does not leave skipped compiles waiting for a first paint that already happened", async () => {
    await prepare(); await startCompile();
    await finishCompile({ ...result("old-run"), skipped: true });
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(requests("/compile/artifacts")).toHaveLength(1);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("discards pending artifact refreshes and local results after switching roots", async () => {
    await prepare(); await startCompile(); await finishCompile();
    await render({ mainFile: "other.tex" });
    await act(async () => current.pdfDisplayed("/pdf?run=new-run"));
    expect(requests("/compile/artifacts")).toHaveLength(0);
    expect(current.pdfUrl).toBe("");
  });

  it("does not publish an old root's local response into the new root", async () => {
    await prepare(); await startCompile(); await render({ mainFile: "other.tex" });
    await finishCompile();
    expect(current.pdfUrl).toBe("");
    expect(requests("/compile/artifacts")).toHaveLength(0);
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });
});
