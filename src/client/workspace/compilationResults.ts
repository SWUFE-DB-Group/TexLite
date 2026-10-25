import type { CompileDiagnostics } from "../compileDiagnostics";
import type { CompileOutcome } from "../compileLog";

export interface CompilationSelection {
  projectId: string;
  mainFile: string;
}

export interface CompilationRunIdentity extends CompilationSelection {
  runId: string;
}

interface LatestRun {
  id: string;
  status: string;
  log: string;
  diagnostics: CompileDiagnostics;
  requestedBy?: { id: string; username: string; name: string } | null;
}

export interface LatestCompileResponse {
  mainFile: string;
  latestRun: LatestRun | null;
  pdfUrl: string | null;
  pdfCompiledAt: string | null;
  pdfSizeBytes: number | null;
  pdfLoadingMode: "full" | "range" | null;
}

export interface CompileResponse extends Omit<LatestCompileResponse, "latestRun"> {
  runId: string;
  ok: boolean;
  cancelled?: boolean;
  skipped?: boolean;
  stale?: boolean;
  log: string;
  diagnostics: CompileDiagnostics;
}

export interface CompilationSnapshot {
  selection: CompilationSelection;
  run: { identity: CompilationRunIdentity; log: string; diagnostics: CompileDiagnostics; outcome: CompileOutcome } | null;
  // The retained successful PDF can belong to a different run from a failed
  // latest result. Never infer its owner from the latest result's run id.
  pdf: { identity: CompilationRunIdentity; url: string; compiledAt: string | null; sizeBytes: number | null; loadingMode: "full" | "range" } | null;
}

interface Reception {
  snapshot: CompilationSnapshot;
  pdfChanged: boolean;
  focusPdf: boolean;
}

/** One selection lifetime, not a project-wide cache. A -> B -> A creates a
 * new owner, so the first A's late responses cannot mutate the second A.
 * All run/PDF publication and reset decisions live here; HTTP lifetimes stay
 * in the workspace hook. Snapshots are immutable React render values.
 */
export class CompilationResults {
  private value: CompilationSnapshot;
  private sharedAllowed: boolean;
  private initialAllowed: boolean;

  constructor(readonly selection: CompilationSelection, readonly restoreRetained: boolean) {
    this.value = { selection, run: null, pdf: null };
    this.sharedAllowed = restoreRetained;
    this.initialAllowed = restoreRetained;
  }

  get snapshot(): CompilationSnapshot { return this.value; }
  get sharedCompletionAllowed(): boolean { return this.sharedAllowed; }
  observeRunning(): void { this.sharedAllowed = true; }

  hasRun(runId: string): boolean {
    return this.snapshot.run?.identity.runId === runId && this.snapshot.run.outcome !== null;
  }

  /** Call after saving succeeds, immediately before submitting compilation. */
  beginCompile(): void {
    this.initialAllowed = false;
    this.sharedAllowed = true;
    this.value = { ...this.snapshot, run: null };
  }

  clean(mode: "cache" | "artifacts"): void {
    this.initialAllowed = false;
    if (mode === "artifacts") this.value = { selection: this.selection, run: null, pdf: null };
  }

  receiveLatest(response: LatestCompileResponse, source: "initial" | "shared"): Reception | null {
    if (response.mainFile !== this.selection.mainFile) return null;
    if (source === "initial" ? !this.initialAllowed : !this.sharedCompletionAllowed) return null;
    if (source === "shared" && (!response.latestRun || this.hasRun(response.latestRun.id))) return null;
    const latest = response.latestRun;
    const outcome: CompileOutcome = latest?.status === "succeeded" ? "succeeded"
      : latest?.log.includes("Compilation was cancelled.") ? "cancelled"
      : latest?.status === "failed" ? "failed" : null;
    return this.receive(response, latest ? { identity: { ...this.selection, runId: latest.id }, log: latest.log, diagnostics: latest.diagnostics, outcome } : null, source !== "initial");
  }

  receiveLocal(response: CompileResponse): Reception | null {
    if (response.mainFile !== this.selection.mainFile) return null;
    return this.receive(response, {
      identity: { ...this.selection, runId: response.runId }, log: response.log, diagnostics: response.diagnostics,
      outcome: response.cancelled ? "cancelled" : response.ok ? "succeeded" : "failed"
    }, true, response.skipped);
  }

  private receive(response: Omit<LatestCompileResponse, "latestRun">, run: CompilationSnapshot["run"], completion: boolean, skipped = false): Reception {
    const previous = this.snapshot;
    const alreadyApplied = run ? this.hasRun(run.identity.runId) : false;
    let pdf = previous.pdf;
    if (response.pdfUrl) {
      // Successful PDF URLs are immutable and include their own run identity.
      const runId = new URL(response.pdfUrl, "https://texlite.invalid/").searchParams.get("run");
      if (!runId) throw new Error("PDF response is missing its compile run identity");
      pdf = {
        identity: { ...this.selection, runId }, url: response.pdfUrl, compiledAt: response.pdfCompiledAt,
        sizeBytes: response.pdfSizeBytes, loadingMode: response.pdfLoadingMode ?? "full"
      };
    } else if (!completion) pdf = null;
    this.initialAllowed = false;
    this.value = { selection: this.selection, run, pdf };
    return {
      snapshot: this.snapshot,
      pdfChanged: previous.pdf?.url !== pdf?.url,
      focusPdf: completion && run?.outcome === "succeeded" && Boolean(response.pdfUrl) && (skipped || !alreadyApplied)
    };
  }
}
