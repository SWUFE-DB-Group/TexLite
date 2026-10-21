import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexFormatterWorkerRequest, BibtexFormatterWorkerResponse } from "../src/client/bibtexFormatterProtocol";

describe("BibTeX formatting worker", () => {
  let receive: (event: MessageEvent<BibtexFormatterWorkerRequest>) => void;
  let respond: ReturnType<typeof vi.fn<(message: BibtexFormatterWorkerResponse) => void>>;

  beforeEach(async () => {
    vi.resetModules();
    respond = vi.fn();
    const scope = { onmessage: null as typeof receive | null, postMessage: respond };
    vi.stubGlobal("self", scope);
    await import("../src/client/bibtexFormatterWorker");
    receive = scope.onmessage!;
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  function request(data: BibtexFormatterWorkerRequest): BibtexFormatterWorkerResponse {
    receive({ data } as MessageEvent<BibtexFormatterWorkerRequest>);
    return respond.mock.calls.at(-1)![0];
  }

  it("formats nested BibTeX without loading the TeX WASM formatter", () => {
    const result = request({ id: 1, action: "format", maxBytes: 1024,
      source: '@article{x,author={Ommer, Bj{\\"o}rn},title={{Nested} title},year=2026}' });
    expect(result).toMatchObject({ id: 1, action: "format", ok: true });
    if (!result.ok || result.action !== "format") throw new Error("Expected formatted BibTeX");
    expect(result.result).toContain('Ommer, Bj{\\"o}rn');
    expect(result.result).toContain("title         = {{Nested} title}");
  });

  it("returns typed syntax and UTF-8 size errors, then continues handling requests", () => {
    expect(request({ id: 1, action: "format", source: "@article{x title={Y}}", maxBytes: 1024 }))
      .toEqual({ id: 1, ok: false, kind: "invalid" });
    const source = "@article{x,title={中文}}";
    expect(request({ id: 2, action: "format", source, maxBytes: source.length }))
      .toEqual({ id: 2, ok: false, kind: "too-large" });
    expect(request({ id: 3, action: "format", source, maxBytes: 1024 }))
      .toMatchObject({ id: 3, ok: true, action: "format" });
    expect(request({ id: 4, action: "format", source: " \n", maxBytes: 1024 }))
      .toEqual({ id: 4, ok: true, action: "format", result: " \n" });
  });

  it("computes Unicode-safe selection edits without changing surrounding text", () => {
    const source = "😁𠀁😁";
    const formatted = "😀𠀁a𠀀";
    const prefix = "@comment{before}\n";
    const suffix = "\n@comment{after}";
    const result = request({ id: 1, action: "diff", source, formatted, baseOffset: prefix.length });
    if (!result.ok || result.action !== "diff") throw new Error("Expected diff edits");
    let document = prefix + source + suffix;
    for (const edit of [...result.result].reverse()) {
      document = document.slice(0, edit.from) + edit.replacement + document.slice(edit.to);
      expect(() => encodeURIComponent(document)).not.toThrow();
    }
    expect(document).toBe(prefix + formatted + suffix);
  });
});
