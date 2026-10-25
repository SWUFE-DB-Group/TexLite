import { describe, expect, it } from "vitest";
import { CompilationResults, type CompileResponse, type LatestCompileResponse } from "../src/client/workspace/compilationResults";

function result(runId: string, ok = true): CompileResponse {
  return {
    mainFile: "main.tex", runId, ok, log: runId, diagnostics: { warnings: [], errors: [] },
    pdfUrl: ok ? `/pdf?run=${runId}` : null, pdfCompiledAt: "2026-10-25T00:00:00Z", pdfSizeBytes: 1234, pdfLoadingMode: "range"
  };
}
function latest(runId: string, ok = true): LatestCompileResponse {
  return { ...result(runId, ok), latestRun: { id: runId, status: ok ? "succeeded" : "failed", log: runId, diagnostics: { warnings: [], errors: [] } } };
}
const owner = (restore = true) => new CompilationResults({ projectId: "paper", mainFile: "main.tex" }, restore);

describe("compilation result ownership", () => {
  it("keeps latest-run and retained-PDF identities distinct after a failed compile", () => {
    const state = owner();
    const response = { ...latest("failed", false), pdfUrl: "/pdf?run=successful" };
    const received = state.receiveLatest(response, "initial")!;
    expect(received.snapshot.run).toMatchObject({ identity: { projectId: "paper", mainFile: "main.tex", runId: "failed" }, outcome: "failed" });
    expect(received.snapshot.pdf).toMatchObject({ identity: { projectId: "paper", mainFile: "main.tex", runId: "successful" }, loadingMode: "range" });
    expect(received.focusPdf).toBe(false);
  });

  it.each([true, false])("does not let bootstrap replace a local completion (ok=%s)", (ok) => {
    const state = owner();
    state.receiveLatest(latest("old"), "initial");
    const retained = state.snapshot.pdf;
    state.beginCompile();
    expect(state.snapshot.run).toBeNull();
    expect(state.snapshot.pdf).toBe(retained);
    expect(state.receiveLatest(latest("late-bootstrap"), "initial")).toBeNull();
    state.receiveLocal(result("new", ok));
    const accepted = state.snapshot;
    expect(state.receiveLatest(latest("late-bootstrap"), "initial")).toBeNull();
    expect(state.snapshot).toBe(accepted);
    expect(state.snapshot.pdf?.identity.runId).toBe(ok ? "new" : "old");
  });

  it("deduplicates shared replays without suppressing a pending run's completion", () => {
    const state = owner();
    const running = latest("running");
    running.latestRun!.status = "running";
    running.pdfUrl = "/pdf?run=previous";
    state.receiveLatest(running, "initial");
    expect(state.hasRun("running")).toBe(false);
    expect(state.receiveLatest(latest("running"), "shared")).toMatchObject({ focusPdf: true, pdfChanged: true });
    const completed = state.snapshot;
    expect(state.hasRun("running")).toBe(true);
    expect(state.receiveLatest(latest("running"), "shared")).toBeNull();
    expect(state.snapshot).toBe(completed);
  });

  it("requires a new run after switching roots, but allows retained results in a reopened workspace", () => {
    const switched = owner(false);
    expect(switched.receiveLatest(latest("old"), "initial")).toBeNull();
    expect(switched.receiveLatest(latest("old"), "shared")).toBeNull();
    switched.observeRunning();
    expect(switched.receiveLatest(latest("new"), "shared")?.snapshot.pdf?.identity.runId).toBe("new");
    expect(owner().receiveLatest(latest("old"), "initial")?.snapshot.pdf?.identity.runId).toBe("old");
  });

  it("rejects another root without partially changing the snapshot", () => {
    const state = owner();
    const empty = state.snapshot;
    expect(state.receiveLatest({ ...latest("other"), mainFile: "other.tex" }, "initial")).toBeNull();
    expect(state.receiveLocal({ ...result("other"), mainFile: "other.tex" })).toBeNull();
    expect(state.snapshot).toBe(empty);
  });

  it("preserves cache-only results, clears generated output together, and cannot restore a late bootstrap", () => {
    const state = owner();
    state.receiveLatest(latest("old"), "initial");
    const before = state.snapshot;
    state.clean("cache");
    expect(state.snapshot).toBe(before);
    state.clean("artifacts");
    expect(state.snapshot).toEqual({ selection: state.selection, run: null, pdf: null });
    expect(state.receiveLatest(latest("old"), "initial")).toBeNull();
  });

  it("focuses skipped local compiles even when the immutable PDF is unchanged", () => {
    const state = owner();
    state.receiveLatest(latest("old"), "initial");
    expect(state.receiveLocal({ ...result("old"), skipped: true })).toMatchObject({ focusPdf: true, pdfChanged: false });
    expect(state.receiveLatest(latest("old"), "shared")).toBeNull();
  });
});
