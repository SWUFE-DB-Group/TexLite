// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState, type SetStateAction } from "react";
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
type CompileResult = LatestCompileResponse & { runId: string; ok: boolean; skipped?: boolean; cancelled?: boolean; log: string; diagnostics: { warnings: []; errors: [] } };
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
function activeResult(runId: string, status: "queued" | "running" = "running"): LatestCompileResponse {
  return {
    ...result("old-run"),
    latestRun: { ...result(runId).latestRun!, status, requestedBy: sharedState(runId).requestedBy }
  };
}

let root: Root, container: HTMLDivElement, options: Options;
let current: ReturnType<typeof useProjectCompilation>;
let latest: LatestCompileResponse;
let post: ReturnType<typeof deferred<CompileResult>>;
let compilePromise: Promise<void>;
let strictMode = false;
let unmounted = false;

function Harness(props: Options) { current = useProjectCompilation(props); return null; }
function updateSharedState(update: SetStateAction<Options["sharedState"]>) {
  options = { ...options, sharedState: typeof update === "function" ? update(options.sharedState) : update };
  root.render(createElement(Harness, options));
}
async function render(overrides: Partial<Options> = {}) {
  options = { ...options, ...overrides };
  await act(async () => { root.render(strictMode ? createElement(StrictMode, null, createElement(Harness, options)) : createElement(Harness, options)); });
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
  strictMode = false; unmounted = false;
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latest = result("old-run"); post = deferred<CompileResult>();
  vi.mocked(api).mockReset().mockImplementation(async (url, init) => {
    if (url.includes("/compile/latest")) return latest;
    if (url.includes("/compile/artifacts")) return { artifacts: [] };
    if (url.endsWith("/compile/clean")) return { ok: true, ...JSON.parse(String(init?.body)) };
    if (url.endsWith("/compile/cancel")) return { cancelled: true };
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
  if (!unmounted) await act(async () => root.unmount());
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("compilation selection and request lifetimes", () => {
  it("waits for a known root and never requests an implicit default first", async () => {
    await render({ mainFile: "" });
    expect(requests("/compile/latest")).toHaveLength(0);
    expect(current.pdfLoading).toBe(false);
    await render({ mainFile: "main.tex" });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
  });

  it.each(["mismatch", "failure"])("consumes a %s route preload and falls back to a fresh lookup", async (mode) => {
    const preload = deferred<LatestCompileResponse>();
    await render({ initialLatest: preload.promise });
    expect(requests("/compile/latest")).toHaveLength(0);
    await act(async () => {
      if (mode === "failure") preload.reject(new Error("preload failed"));
      else preload.resolve({ ...result("wrong-root"), mainFile: "other.tex" });
    });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    await render({ onPdfChanged: vi.fn() });
    expect(requests("/compile/latest")).toHaveLength(1);
    await render({ mainFile: "other.tex" });
    await render({ mainFile: "main.tex" });
    expect(current.pdfUrl).toBe("");
    expect(requests("/compile/latest")).toHaveLength(1);
  });

  it("lets StrictMode cancel and retry bootstrap without accepting the first request's late failure", async () => {
    strictMode = true;
    const stale = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => stale.promise);
    await render();
    expect(requests("/compile/latest")).toHaveLength(2);
    expect(requests("/compile/latest")[0][1]?.signal?.aborted).toBe(true);
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    await act(async () => stale.reject(new Error("late bootstrap failure")));
    expect(current.pdfLoading).toBe(false);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it.each([true, false])("does not overwrite a local result with a delayed bootstrap (ok=%s)", async (ok) => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    await render();
    const signal = requests("/compile/latest")[0][1]?.signal;
    await startCompile(); await finishCompile(result("local", ok));
    expect(signal?.aborted).toBe(true);
    await act(async () => bootstrap.resolve(result("outdated")));
    expect(current.compileLog).toBe(ok ? "Compiled successfully." : "Compilation failed.");
    expect(current.compileOutcome).toBe(ok ? "succeeded" : "failed");
    expect(current.pdfUrl).toBe(ok ? "/pdf?run=local" : "");
    expect(current.pdfLoading).toBe(false);
  });

  it("defers shared replays during bootstrap and does not request a run already returned by bootstrap", async () => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    await render({ sharedState: sharedState() });
    expect(requests("/compile/latest")).toHaveLength(1);
    await act(async () => bootstrap.resolve(result()));
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("recovers through a shared completion if the initial lookup fails", async () => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    latest = result();
    await render({ sharedState: sharedState() });
    await act(async () => bootstrap.reject(new Error("initial connection lost")));
    expect(requests("/compile/latest")).toHaveLength(2);
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
    expect(current.pdfLoading).toBe(false);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it.each(["succeeded", "failed"] as const)("does not replace an already-known %s state with the same run's initial running state", async (status) => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    const terminal = sharedState("same-run", status);
    latest = result("same-run", status === "succeeded");
    await render({ sharedState: terminal, onSharedState: vi.fn(updateSharedState) });
    await act(async () => bootstrap.resolve(activeResult("same-run")));
    expect(options.sharedState).toBe(terminal);
    expect(current.compileOutcome).toBe(status);
    expect(current.pdfUrl).toBe(status === "succeeded" ? "/pdf?run=same-run" : "/pdf?run=old-run");
    expect(requests("/compile/latest")).toHaveLength(2);
  });

  it.each(["succeeded", "failed"] as const)("preserves a %s notification delivered before bootstrap finishes in the same React batch", async (status) => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    const terminal = sharedState("same-run", status);
    latest = result("same-run", status === "succeeded");
    let liveState: Options["sharedState"] = null;
    let deliver!: (state: Options["sharedState"]) => void;
    function LiveHarness() {
      const [state, setState] = useState<Options["sharedState"]>(null);
      liveState = state; deliver = setState;
      current = useProjectCompilation({ ...options, sharedState: state, onSharedState: setState });
      return null;
    }
    await act(async () => root.render(createElement(LiveHarness)));
    await act(async () => {
      deliver(terminal);
      bootstrap.resolve(activeResult("same-run"));
    });
    expect(liveState).toBe(terminal);
    expect(current.compileOutcome).toBe(status);
    expect(current.pdfUrl).toBe(status === "succeeded" ? "/pdf?run=same-run" : "/pdf?run=old-run");
    expect(current.pdfLoading).toBe(false);
  });

  it.each(["running", "succeeded"] as const)("keeps a different run's newer %s notification instead of a delayed bootstrap state", async (status) => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    await render({ onSharedState: vi.fn(updateSharedState) });
    const newer = { ...sharedState("newer-run"), status };
    await render({ sharedState: newer });
    latest = result("newer-run");
    await act(async () => bootstrap.resolve(activeResult("old-run")));
    expect(options.sharedState).toBe(newer);
    if (status === "running") await render({ sharedState: sharedState("newer-run") });
    expect(current.pdfUrl).toBe("/pdf?run=newer-run");
    expect(current.compileOutcome).toBe("succeeded");
  });

  it.each(["queued", "running"] as const)("seeds an initial %s state when no collaboration state exists", async (status) => {
    latest = activeResult("active-run", status);
    await render({ onSharedState: vi.fn(updateSharedState) });
    expect(options.sharedState).toMatchObject({ mainFile: "main.tex", runId: "active-run", status });
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(requests("/compile/latest")).toHaveLength(1);
  });

  it("allows an initial lookup to discover a new run after an older completed run", async () => {
    latest = activeResult("genuinely-new");
    await render({ sharedState: sharedState("completed-earlier"), onSharedState: vi.fn(updateSharedState) });
    expect(options.sharedState).toMatchObject({ runId: "genuinely-new", status: "running" });
    expect(requests("/compile/latest")).toHaveLength(1);
    latest = result("genuinely-new");
    await render({ sharedState: sharedState("genuinely-new") });
    expect(current.pdfUrl).toBe("/pdf?run=genuinely-new");
    expect(current.compileOutcome).toBe("succeeded");
  });

  it("does not let a route preload overwrite a different run's existing completion", async () => {
    const terminal = sharedState("latest-run");
    latest = result("latest-run");
    await render({
      initialLatest: Promise.resolve(activeResult("preloaded-run")),
      sharedState: terminal, onSharedState: vi.fn(updateSharedState)
    });
    expect(options.sharedState).toBe(terminal);
    expect(current.pdfUrl).toBe("/pdf?run=latest-run");
    expect(current.compileOutcome).toBe("succeeded");
    expect(requests("/compile/latest")).toHaveLength(1);
  });

  it("can discover a genuinely new run through a fresh lookup after a mismatched route preload", async () => {
    latest = activeResult("fresh-run");
    await render({
      initialLatest: Promise.resolve({ ...activeResult("wrong-root"), mainFile: "other.tex" }),
      sharedState: sharedState("previous-run"), onSharedState: vi.fn(updateSharedState)
    });
    expect(options.sharedState).toMatchObject({ runId: "fresh-run", status: "running" });
    expect(requests("/compile/latest")).toHaveLength(1);
  });

  it.each([
    ["running", "queued"], ["queued", "running"]
  ] as const)("never regresses a task when its shared status is %s and bootstrap reports %s", async (status, initialStatus) => {
    const existing = { ...sharedState("active"), status };
    latest = activeResult("active", initialStatus);
    await render({ sharedState: existing, onSharedState: vi.fn(updateSharedState) });
    expect(options.sharedState).toMatchObject({ runId: "active", status: "running" });
    if (status === "running") expect(options.sharedState).toBe(existing);
  });

  it("retains the last good PDF while exposing a failed or cancelled run", async () => {
    await prepare(); await startCompile();
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    await finishCompile({ ...result("cancelled", false), cancelled: true });
    expect(current.compileOutcome).toBe("cancelled");
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(current.editorNotice).toBe("compileControls.cancelled");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("prevents duplicate compiles while waiting for source to be saved", async () => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ save: vi.fn(() => saved.promise) });
    await startCompile();
    await act(async () => { await current.compile(); });
    expect(current.localCompiling).toBe(true);
    expect(requests("/compile")).toHaveLength(0);
    await act(async () => saved.resolve(true));
    expect(requests("/compile")).toHaveLength(1);
    await finishCompile();
    expect(current.localCompiling).toBe(false);
  });

  it.each([false, "error"])("does not start compilation after an unsuccessful save (%s)", async (outcome) => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ sharedState: sharedState("old-run"), save: vi.fn(() => saved.promise) });
    await startCompile();
    expect(current.compileLog).toBe("Compiled successfully.");
    expect(current.compileOutcome).toBe("succeeded");
    await act(async () => {
      if (outcome === "error") saved.reject(new Error("save failed"));
      else saved.resolve(false);
      await compilePromise;
    });
    expect(requests("/compile")).toHaveLength(0);
    expect(current.localCompiling).toBe(false);
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(current.compileLog).toBe("Compiled successfully.");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledTimes(outcome === "error" ? 1 : 0);
  });

  it("clears the previous run only after source saving succeeds", async () => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ sharedState: sharedState("old-run"), save: vi.fn(() => saved.promise) });
    await startCompile();
    expect(current.compileOutcome).toBe("succeeded");
    expect(requests("/compile")).toHaveLength(0);
    await act(async () => saved.resolve(true));
    expect(current.compileOutcome).toBeNull();
    expect(current.compileLog).toBe("");
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(requests("/compile")).toHaveLength(1);
    latest = result();
    await finishCompile();
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("still receives a new collaborator result when local source saving fails", async () => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ sharedState: sharedState("old-run"), save: vi.fn(() => saved.promise) });
    await startCompile();
    latest = result("collaborator");
    await render({ sharedState: sharedState("collaborator") });
    expect(requests("/compile/latest")).toHaveLength(0);
    await act(async () => { saved.resolve(false); await compilePromise; });
    expect(requests("/compile").filter(([url]) => url.endsWith("/compile"))).toHaveLength(0);
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=collaborator");
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("does not restore a switched root's old result when source saving fails", async () => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ mainFile: "other.tex", sharedState: { ...sharedState("old-other"), mainFile: "other.tex" }, save: vi.fn(() => saved.promise) });
    latest = { ...result("old-other"), mainFile: "other.tex" };
    await startCompile();
    await act(async () => { saved.resolve(false); await compilePromise; });
    expect(requests("/compile")).toHaveLength(0);
    expect(current.pdfUrl).toBe("");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("does not start a stale compile if the project changes while saving", async () => {
    await prepare();
    const saved = deferred<boolean>();
    await render({ save: vi.fn(() => saved.promise) });
    await startCompile();
    latest = result("project-b");
    await render({ projectId: "other", project: { ...options.project!, id: "other" } });
    await act(async () => { saved.resolve(true); await compilePromise; });
    expect(requests("/compile").filter(([url]) => url.endsWith("/compile"))).toHaveLength(0);
    expect(current.pdfUrl).toBe("/pdf?run=project-b");
    expect(current.localCompiling).toBe(false);
  });

  it.each(["success", "failure"])("ignores a previous project's late POST %s even when both roots have the same filename", async (outcome) => {
    await prepare(); await startCompile();
    const postSignal = requests("/compile")[0][1]?.signal;
    latest = result("project-b");
    await render({ projectId: "other", project: { ...options.project!, id: "other" } });
    expect(postSignal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "failure") post.reject(new Error("old project error"));
      else post.resolve(result("project-a"));
      await compilePromise;
    });
    expect(current.pdfUrl).toBe("/pdf?run=project-b");
    expect(current.localCompiling).toBe(false);
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("does not revive the first A's compile after an A -> B -> A root switch", async () => {
    await prepare(); await startCompile();
    const signal = requests("/compile")[0][1]?.signal;
    await render({ mainFile: "other.tex" }); await render({ mainFile: "main.tex" });
    expect(signal?.aborted).toBe(false);
    expect(current.localCompiling).toBe(true);
    await act(async () => { await current.compile(); });
    expect(requests("/compile").filter(([url]) => url.endsWith("/compile"))).toHaveLength(1);
    await finishCompile();
    expect(current.pdfUrl).toBe("");
    expect(current.compileLog).toBe("");
    expect(current.localCompiling).toBe(false);
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("does not revive an old local result after leaving and reopening the same project", async () => {
    await prepare(); await startCompile();
    latest = result("project-b");
    await render({ projectId: "other" });
    latest = result("reopened-a");
    await render({ projectId: "paper" });
    expect(current.localCompiling).toBe(false);
    await finishCompile();
    expect(current.pdfUrl).toBe("/pdf?run=reopened-a");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("keeps a new compile busy when a retired project's request finishes with %s", async (outcome) => {
    await prepare(); await startCompile();
    const retiredPost = post, retiredCompile = compilePromise;
    await render({ projectId: "other" });
    await render({ projectId: "paper" });
    expect(current.localCompiling).toBe(false);
    post = deferred<CompileResult>();
    await startCompile();
    expect(current.localCompiling).toBe(true);
    expect(requests("/compile").filter(([url]) => url.endsWith("/compile"))).toHaveLength(2);
    await act(async () => {
      if (outcome === "failure") retiredPost.reject(new Error("retired compile failed"));
      else retiredPost.resolve(result("retired"));
      await retiredCompile;
    });
    expect(current.localCompiling).toBe(true);
    expect(options.onError).not.toHaveBeenCalled();
    await finishCompile(result("fresh"));
    expect(current.localCompiling).toBe(false);
    expect(current.pdfUrl).toBe("/pdf?run=fresh");
  });

  it("adopts a root promoted synchronously by the compile command before React commits it", async () => {
    await prepare();
    let intendedRoot = "main.tex";
    await render({ getCurrentMainFile: () => intendedRoot, resolveCompileMainFile: () => {
      intendedRoot = "other.tex";
      options = { ...options, mainFile: intendedRoot };
      root.render(createElement(Harness, options));
      return intendedRoot;
    } });
    await startCompile();
    expect(JSON.parse(String(requests("/compile")[0][1]?.body))).toEqual({ mainFile: "other.tex" });
    await finishCompile({ ...result("promoted-root"), mainFile: "other.tex" });
    expect(current.pdfUrl).toBe("/pdf?run=promoted-root");
    expect(current.localCompiling).toBe(false);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("ignores an earlier shared lookup without hiding the later lookup's loading state", async () => {
    await prepare();
    const first = deferred<LatestCompileResponse>(), second = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await render({ sharedState: sharedState("one") });
    const signal = requests("/compile/latest")[0][1]?.signal;
    await render({ sharedState: sharedState("two") });
    expect(signal?.aborted).toBe(true);
    await act(async () => first.resolve(result("one")));
    expect(current.pdfLoading).toBe(true);
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    await act(async () => second.resolve(result("two")));
    expect(current.pdfLoading).toBe(false);
    expect(current.pdfUrl).toBe("/pdf?run=two");
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it.each(["root", "run"])("ignores a shared completion lookup for a different %s", async (mismatch) => {
    await prepare();
    latest = mismatch === "run" ? result("another-run") : { ...result(), mainFile: "other.tex" };
    await render({ sharedState: sharedState() });
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
    expect(current.pdfLoading).toBe(false);
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("ignores completed root-switch replays until a new shared compile starts", async () => {
    await prepare();
    const state = { ...sharedState(), mainFile: "other.tex" };
    await render({ mainFile: "other.tex", sharedState: state });
    expect(requests("/compile/latest")).toHaveLength(0);
    expect(current.pdfUrl).toBe("");
    await render({ sharedState: { ...state, status: "running" } });
    latest = { ...result(), mainFile: "other.tex" };
    await render({ sharedState: state });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=new-run");
  });

  it.each(["cache", "artifacts"] as const)("applies %s cleanup at the correct scope and guards repeat submissions", async (mode) => {
    await prepare();
    const onSharedState = vi.fn(updateSharedState);
    await render({ sharedState: sharedState("old-run"), onSharedState });
    const clean = deferred<{ ok: boolean; mode: typeof mode; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile(mode); });
    expect(current.cleaning).toBe(true);
    await act(async () => { await current.cleanCompile(mode); });
    expect(requests("/compile/clean")).toHaveLength(1);
    await act(async () => { clean.resolve({ ok: true, mode, mainFile: "main.tex" }); await cleaning; });
    expect(current.pdfUrl).toBe(mode === "cache" ? "/pdf?run=old-run" : "");
    expect(current.compileLog).toBe(mode === "cache" ? "Compiled successfully." : "");
    expect(current.cleaning).toBe(false);
    expect(options.onSharedState).toHaveBeenLastCalledWith(null);
    expect(requests("/compile/latest")).toHaveLength(0);
  });

  it.each(["succeeded", "failed"] as const)("receives a deferred %s completion after cleanup fails", async (status) => {
    await prepare();
    const clean = deferred<{ ok: boolean; mode: string; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile("cache"); });
    latest = result("collaborator", status === "succeeded");
    await render({ sharedState: sharedState("collaborator", status) });
    expect(requests("/compile/latest")).toHaveLength(0);
    await act(async () => { clean.reject(new Error("cleanup failed")); await cleaning; });
    expect(current.cleaning).toBe(false);
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfLoading).toBe(false);
    expect(current.compileOutcome).toBe(status);
    expect(current.pdfUrl).toBe(status === "succeeded" ? "/pdf?run=collaborator" : "/pdf?run=old-run");
    expect(options.onCompileSuccess).toHaveBeenCalledTimes(status === "succeeded" ? 1 : 0);
    expect(options.onError).toHaveBeenCalledWith("cleanup failed");
  });

  it("restarts a completion lookup interrupted by failed cleanup without accepting the aborted response", async () => {
    await prepare();
    const lookup = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => lookup.promise);
    await render({ sharedState: sharedState("collaborator") });
    const signal = requests("/compile/latest")[0][1]?.signal;
    const clean = deferred<{ ok: boolean; mode: string; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile("artifacts"); });
    expect(signal?.aborted).toBe(true);
    latest = result("collaborator");
    await act(async () => { clean.reject(new Error("cleanup failed")); await cleaning; });
    expect(requests("/compile/latest")).toHaveLength(2);
    expect(current.pdfUrl).toBe("/pdf?run=collaborator");
    await act(async () => lookup.resolve(result("outdated")));
    expect(current.pdfUrl).toBe("/pdf?run=collaborator");
    expect(current.pdfLoading).toBe(false);
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it.each(["cache", "artifacts"] as const)("does not discard a newer completion when %s cleanup succeeds", async (mode) => {
    await prepare();
    const onSharedState = vi.fn(updateSharedState);
    await render({ onSharedState });
    const clean = deferred<{ ok: boolean; mode: string; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile(mode); });
    // The server finished cleaning, then published another compile before
    // the original cleanup response reached this browser.
    latest = result("after-cleanup");
    await render({ sharedState: sharedState("after-cleanup") });
    expect(requests("/compile/latest")).toHaveLength(0);
    await act(async () => { clean.resolve({ ok: true, mode, mainFile: "main.tex" }); await cleaning; });
    expect(onSharedState).not.toHaveBeenCalled();
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("/pdf?run=after-cleanup");
    expect(current.compileOutcome).toBe("succeeded");
    expect(options.onCompileSuccess).toHaveBeenCalledOnce();
  });

  it("does not restore an output removed by cleanup merely because its completion was deferred", async () => {
    await prepare();
    const clean = deferred<{ ok: boolean; mode: string; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile("artifacts"); });
    await render({ sharedState: sharedState("removed") });
    latest = { mainFile: "main.tex", latestRun: null, pdfUrl: null, pdfCompiledAt: null, pdfSizeBytes: null, pdfLoadingMode: null };
    await act(async () => { clean.resolve({ ok: true, mode: "artifacts", mainFile: "main.tex" }); await cleaning; });
    expect(requests("/compile/latest")).toHaveLength(1);
    expect(current.pdfUrl).toBe("");
    expect(current.compileLog).toBe("");
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("does not let a late bootstrap restore output removed by a shared cleanup", async () => {
    const bootstrap = deferred<LatestCompileResponse>();
    vi.mocked(api).mockImplementationOnce(() => bootstrap.promise);
    await render();
    await render({ sharedState: { ...sharedState("clean"), status: "cleaned", cleanMode: "artifacts" } });
    await act(async () => bootstrap.resolve(result("removed")));
    expect(current.pdfUrl).toBe("");
    expect(current.compileLog).toBe("");
    expect(current.pdfLoading).toBe(false);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("does not apply a previous root's cleanup %s after switching away and back", async (outcome) => {
    await prepare();
    const clean = deferred<{ ok: boolean; mode: string; mainFile: string }>();
    vi.mocked(api).mockImplementationOnce(() => clean.promise);
    let cleaning!: Promise<void>;
    await act(async () => { cleaning = current.cleanCompile("artifacts"); });
    const signal = requests("/compile/clean")[0][1]?.signal;
    await render({ mainFile: "other.tex" }); await render({ mainFile: "main.tex" });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "failure") clean.reject(new Error("old cleanup failure"));
      else clean.resolve({ ok: true, mode: "artifacts", mainFile: "main.tex" });
      await cleaning;
    });
    expect(current.editorNotice).toBe("");
    expect(options.onSharedState).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it.each(["content", "error"])("ignores late artifact preview %s after publishing a new PDF", async (outcome) => {
    await prepare();
    const preview = deferred<{ path: string; content: string }>();
    vi.mocked(api).mockImplementationOnce(() => preview.promise);
    let reading!: Promise<void>;
    await act(async () => { reading = current.viewArtifact({ path: "main.log", size: 1, viewable: true }); });
    const signal = requests("/compile/artifacts")[0][1]?.signal;
    await startCompile(); await finishCompile();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "error") preview.reject(new Error("old artifact error"));
      else preview.resolve({ path: "main.log", content: "outdated log" });
      await reading;
    });
    expect(current.artifactPreview).toBeNull();
    expect(current.artifactLoading).toBe(false);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("cancels outstanding POSTs and ignores their errors after unmount", async () => {
    await prepare(); await startCompile();
    const signal = requests("/compile")[0][1]?.signal;
    await act(async () => { root.unmount(); unmounted = true; });
    expect(signal?.aborted).toBe(true);
    await act(async () => { post.reject(new Error("unmounted compile error")); await compilePromise; });
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onCompileSuccess).not.toHaveBeenCalled();
  });

  it("cancels deferred bootstrap scans if compilation starts before the background timer runs", async () => {
    await render();
    vi.mocked(api).mockClear();
    await startCompile(); await finishCompile();
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(requests("/compile/artifacts")).toHaveLength(0);
    expect(options.loadOutline).not.toHaveBeenCalled();
    await act(async () => current.pdfDisplayed("/pdf?run=new-run"));
    expect(requests("/compile/artifacts")).toHaveLength(1);
  });

  it("keeps the matching artifact preview readable and aborts it on a root switch", async () => {
    await prepare();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((url, init) => url.includes("&path=")
      ? Promise.resolve({ path: "main.log", content: "current log" }) : implementation(url, init));
    await act(async () => { await current.viewArtifact({ path: "main.log", size: 10, viewable: true }); });
    expect(current.artifactPreview).toEqual({ path: "main.log", content: "current log" });
    expect(current.artifactLoading).toBe(false);
    const pending = deferred<{ path: string; content: string }>();
    vi.mocked(api).mockImplementationOnce(() => pending.promise);
    let reading!: Promise<void>;
    await act(async () => { reading = current.viewArtifact({ path: "main.log", size: 10, viewable: true }); });
    const signal = requests("&path=").at(-1)![1]?.signal;
    await render({ mainFile: "other.tex" }); await render({ mainFile: "main.tex" });
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve({ path: "main.log", content: "old selection" }); await reading; });
    expect(current.artifactPreview).toBeNull();
    expect(current.artifactLoading).toBe(false);
  });

  it("deduplicates pending cancellation and clears its state when the shared run ends", async () => {
    await prepare();
    await render({ sharedState: { ...sharedState(), status: "running" } });
    const cancel = deferred<{ cancelled: boolean }>();
    vi.mocked(api).mockImplementationOnce(() => cancel.promise);
    let cancelling!: Promise<void>;
    await act(async () => { cancelling = current.cancelCompile(); });
    await act(async () => { await current.cancelCompile(); });
    expect(current.cancelling).toBe(true);
    expect(requests("/compile/cancel")).toHaveLength(1);
    await act(async () => { cancel.resolve({ cancelled: true }); await cancelling; });
    latest = { ...result("new-run", false), latestRun: { ...result("new-run", false).latestRun!, log: "Compilation was cancelled." } };
    await render({ sharedState: sharedState("new-run", "failed") });
    expect(current.cancelling).toBe(false);
    expect(current.compileOutcome).toBe("cancelled");
    expect(current.pdfUrl).toBe("/pdf?run=old-run");
  });

  it("keeps cancellation errors and finally handlers scoped to their original project", async () => {
    await prepare();
    const cancel = deferred<{ cancelled: boolean }>();
    vi.mocked(api).mockImplementationOnce(() => cancel.promise);
    let cancelling!: Promise<void>;
    await act(async () => { cancelling = current.cancelCompile(); });
    const signal = requests("/compile/cancel")[0][1]?.signal;
    latest = result("project-b");
    await render({ projectId: "other" });
    expect(signal?.aborted).toBe(true);
    await act(async () => { cancel.reject(new Error("old cancellation failure")); await cancelling; });
    expect(current.cancelling).toBe(false);
    expect(current.pdfUrl).toBe("/pdf?run=project-b");
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("clears cancellation state even after its request has settled when leaving a project", async () => {
    await prepare();
    const running = { ...sharedState(), status: "running" as const };
    await render({ sharedState: running });
    await act(async () => { await current.cancelCompile(); });
    expect(current.cancelling).toBe(true);
    await render({ projectId: "other", sharedState: null });
    await render({ projectId: "paper", sharedState: running });
    expect(current.cancelling).toBe(false);
    expect(requests("/compile/cancel")).toHaveLength(1);
    await act(async () => { await current.cancelCompile(); });
    expect(requests("/compile/cancel")).toHaveLength(2);
  });

  it("consumes Ctrl/Cmd+S in forms and dialogs but still compiles from the source editor", async () => {
    await prepare();
    const controls: HTMLElement[] = [document.createElement("input"), document.createElement("textarea"), document.createElement("select")];
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog");
    const dialogButton = document.createElement("button"); dialog.append(dialogButton); controls.push(dialogButton);
    const terminal = document.createElement("section"); terminal.setAttribute("data-agent-terminal", "true");
    const terminalButton = document.createElement("button"); terminal.append(terminalButton); controls.push(terminalButton);
    container.append(...controls.slice(0, 3), dialog, terminal);
    for (const target of controls) {
      const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(options.save).not.toHaveBeenCalled();
    const source = document.createElement("div"); source.contentEditable = "true"; container.append(source);
    await act(async () => { source.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true })); });
    expect(requests("/compile")).toHaveLength(1);
    await act(async () => post.resolve(result()));
    expect(current.compileOutcome).toBe("succeeded");
  });
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
