import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexFormatterWorkerRequest, BibtexFormatterWorkerResponse } from "../src/client/bibtexFormatterProtocol";

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<BibtexFormatterWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: BibtexFormatterWorkerRequest[] = [];
  readonly terminate = vi.fn();
  constructor(readonly url: URL, readonly options: WorkerOptions) { MockWorker.instances.push(this); }
  postMessage(message: BibtexFormatterWorkerRequest) { this.messages.push(message); }
  respond(data: BibtexFormatterWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<BibtexFormatterWorkerResponse>);
  }
}

describe("BibTeX formatting worker client", () => {
  let formatter: typeof import("../src/client/bibtexFormatter");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
    formatter = await import("../src/client/bibtexFormatter");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lazily reuses its own Worker and matches format/diff responses to requests", async () => {
    expect(MockWorker.instances).toHaveLength(0);
    const format = formatter.formatBibtexInWorker("source", 1024);
    const diff = formatter.createBibtexTextEdits("old", "new", 20);
    expect(MockWorker.instances).toHaveLength(1);
    const worker = MockWorker.instances[0];
    expect(worker.url.pathname).toMatch(/\/bibtexFormatterWorker\.ts$/);
    expect(worker.options).toEqual({ type: "module", name: "texlite-bibtex-formatter" });
    const [formatRequest, diffRequest] = worker.messages;
    expect(formatRequest).toMatchObject({ action: "format", source: "source", maxBytes: 1024 });
    expect(diffRequest).toMatchObject({ action: "diff", source: "old", formatted: "new", baseOffset: 20 });
    const edits = [{ from: 20, to: 23, replacement: "new" }];
    worker.respond({ id: diffRequest.id, ok: true, action: "diff", result: edits });
    worker.respond({ id: formatRequest.id, ok: true, action: "format", result: "formatted" });
    await expect(format).resolves.toBe("formatted");
    await expect(diff).resolves.toEqual(edits);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the Worker after user-correctable input errors", async () => {
    const invalid = formatter.formatBibtexInWorker("broken", 1024);
    const rejected = expect(invalid).rejects.toMatchObject({ kind: "invalid" });
    const worker = MockWorker.instances[0];
    worker.respond({ id: worker.messages[0].id, ok: false, kind: "invalid" });
    await rejected;
    const retry = formatter.formatBibtexInWorker("fixed", 1024);
    worker.respond({ id: worker.messages[1].id, ok: true, action: "format", result: "fixed" });
    await expect(retry).resolves.toBe("fixed");
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it.each(["onerror", "onmessageerror"] as const)("rejects pending work after %s and recreates the Worker on retry", async (failure) => {
    const pending = formatter.formatBibtexInWorker("source", 1024);
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unavailable" });
    const worker = MockWorker.instances[0];
    worker[failure]?.();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = formatter.formatBibtexInWorker("source", 1024);
    const replacement = MockWorker.instances[1];
    // A late event from the discarded Worker cannot break the new one.
    worker[failure]?.();
    replacement.respond({ id: replacement.messages[0].id, ok: true, action: "format", result: "formatted" });
    await expect(retry).resolves.toBe("formatted");
    expect(replacement.terminate).not.toHaveBeenCalled();
  });

  it("terminates timed-out work and can retry with a fresh Worker", async () => {
    const first = formatter.formatBibtexInWorker("source", 1024);
    const second = formatter.createBibtexTextEdits("old", "new");
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ kind: "timeout" }),
      expect(second).rejects.toMatchObject({ kind: "timeout" })
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = formatter.formatBibtexInWorker("source", 1024);
    const worker = MockWorker.instances[1];
    worker.respond({ id: worker.messages[0].id, ok: true, action: "format", result: "formatted" });
    await expect(retry).resolves.toBe("formatted");
  });

  it("reports unavailable Workers instead of formatting on the main thread", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(formatter.formatBibtexInWorker("source", 1024)).rejects.toMatchObject({ kind: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed diff results before they can reach collaborative text", async () => {
    const pending = formatter.createBibtexTextEdits("old", "new");
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unavailable" });
    const worker = MockWorker.instances[0];
    worker.respond({ id: worker.messages[0].id, ok: true, action: "diff",
      result: [{ from: 2, to: 1, replacement: "new" }] });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
