import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexMetadataWorkerRequest, BibtexMetadataWorkerResponse } from "../src/client/bibtexMetadataProtocol";

describe("BibTeX metadata worker", () => {
  let receive: (event: MessageEvent<BibtexMetadataWorkerRequest>) => void;
  let respond: ReturnType<typeof vi.fn<(message: BibtexMetadataWorkerResponse) => void>>;

  beforeEach(async () => {
    vi.resetModules();
    respond = vi.fn();
    const scope = { onmessage: null as typeof receive | null, postMessage: respond };
    vi.stubGlobal("self", scope);
    await import("../src/client/bibtexMetadataWorker");
    receive = scope.onmessage!;
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  function request(data: BibtexMetadataWorkerRequest): BibtexMetadataWorkerResponse {
    receive({ data } as MessageEvent<BibtexMetadataWorkerRequest>);
    return respond.mock.calls.at(-1)![0];
  }

  it("returns parser-backed summaries for every entry", () => {
    const result = request({
      id: 1,
      source: [
        "@article{first, title={First}, author={Ada}, year={2024}}",
        "@inproceedings{second, title={Second}, booktitle={Proceedings}, year={2025}}"
      ].join("\n")
    });
    expect(result).toEqual({
      id: 1, ok: true, entries: [
        { key: "first", entryType: "article", title: "First", authors: "Ada", year: "2024", venue: null, doi: null, url: null },
        { key: "second", entryType: "inproceedings", title: "Second", authors: null, year: "2025", venue: "Proceedings", doi: null, url: null }
      ]
    });
  });

  it("returns an empty list when the source has no entries", () => {
    expect(request({ id: 2, source: "% only a comment" })).toEqual({ id: 2, ok: true, entries: [] });
  });
});
