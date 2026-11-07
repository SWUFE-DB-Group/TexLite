import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexMetadataWorkerRequest, BibtexMetadataWorkerResponse } from "../src/client/bibtexMetadataProtocol";

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<BibtexMetadataWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: BibtexMetadataWorkerRequest[] = [];
  readonly terminate = vi.fn();
  constructor(readonly url: URL, readonly options: WorkerOptions) { MockWorker.instances.push(this); }
  postMessage(message: BibtexMetadataWorkerRequest) { this.messages.push(message); }
  respond(data: BibtexMetadataWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<BibtexMetadataWorkerResponse>);
  }
}

const summary = {
  key: "paper", entryType: "article", title: "Paper", authors: null, year: "2026", venue: null, doi: null, url: null
};

describe("BibTeX metadata worker client", () => {
  let metadata: typeof import("../src/client/bibtexMetadata");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
    metadata = await import("../src/client/bibtexMetadata");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lazily creates one Worker and matches responses to requests", async () => {
    expect(MockWorker.instances).toHaveLength(0);
    const first = metadata.parseBibtexMetadataInWorker("@article{paper,title={Paper}}");
    const second = metadata.parseBibtexMetadataInWorker("@article{other,title={Other}}");
    expect(MockWorker.instances).toHaveLength(1);
    const worker = MockWorker.instances[0];
    expect(worker.url.pathname).toMatch(/\/bibtexMetadataWorker\.ts$/);
    expect(worker.options).toEqual({ type: "module", name: "texlite-bibtex-metadata" });
    const [firstRequest, secondRequest] = worker.messages;
    worker.respond({ id: secondRequest.id, ok: true, entries: [{ ...summary, key: "other", title: "Other" }] });
    worker.respond({ id: firstRequest.id, ok: true, entries: [summary] });
    await expect(first).resolves.toEqual([summary]);
    await expect(second).resolves.toMatchObject([{ key: "other", title: "Other" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the Worker after a malformed-source response", async () => {
    const invalid = metadata.parseBibtexMetadataInWorker("broken");
    const rejected = expect(invalid).rejects.toMatchObject({ kind: "invalid" });
    const worker = MockWorker.instances[0];
    worker.respond({ id: worker.messages[0].id, ok: false, kind: "invalid" });
    await rejected;
    const retry = metadata.parseBibtexMetadataInWorker("fixed");
    worker.respond({ id: worker.messages[1].id, ok: true, entries: [summary] });
    await expect(retry).resolves.toEqual([summary]);
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it.each(["onerror", "onmessageerror"] as const)("rejects pending work after %s and recreates the Worker", async (failure) => {
    const pending = metadata.parseBibtexMetadataInWorker("source");
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unavailable" });
    const worker = MockWorker.instances[0];
    worker[failure]?.();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = metadata.parseBibtexMetadataInWorker("source");
    const replacement = MockWorker.instances[1];
    worker[failure]?.();
    replacement.respond({ id: replacement.messages[0].id, ok: true, entries: [summary] });
    await expect(retry).resolves.toEqual([summary]);
    expect(replacement.terminate).not.toHaveBeenCalled();
  });

  it("terminates timed-out work and can retry with a fresh Worker", async () => {
    const first = metadata.parseBibtexMetadataInWorker("source");
    const second = metadata.parseBibtexMetadataInWorker("other");
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ kind: "timeout" }),
      expect(second).rejects.toMatchObject({ kind: "timeout" })
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = metadata.parseBibtexMetadataInWorker("source");
    const worker = MockWorker.instances[1];
    worker.respond({ id: worker.messages[0].id, ok: true, entries: [summary] });
    await expect(retry).resolves.toEqual([summary]);
  });

  it("reports unavailable Workers instead of parsing on the main thread", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(metadata.parseBibtexMetadataInWorker("source")).rejects.toMatchObject({ kind: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed summaries before they reach the hover card", async () => {
    const pending = metadata.parseBibtexMetadataInWorker("source");
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unavailable" });
    const worker = MockWorker.instances[0];
    worker.respond({ id: worker.messages[0].id, ok: true, entries: [{ key: "paper" } as never] });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
