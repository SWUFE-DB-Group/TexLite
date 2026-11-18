import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseTexcountOutput, TexcountService } from "../src/server/texcount.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn()
}));

describe("TeXcount output", () => {
  it("parses TexLite's fixed report template and computes the word total", () => {
    const result = parseTexcountOutput("__TEXLITE_TEXCOUNT_WORDS__|128|12|7|4|2|9|3");
    expect(result).toEqual({
      textWords: 128,
      headerWords: 12,
      captionWords: 7,
      totalWords: 147,
      headers: 4,
      floats: 2,
      inlineMath: 9,
      displayMath: 3,
      files: null,
      parserErrors: 0
    });
  });

  it("retains parser error counts without treating a report as invalid", () => {
    const result = parseTexcountOutput("__TEXLITE_TEXCOUNT_WORDS__|0|0|0|0|0|0|0\n(errors:1)");
    expect(result.parserErrors).toBe(1);
    expect(result.totalWords).toBe(0);
  });

  it("rejects output that does not contain TexLite's report template", () => {
    expect(() => parseTexcountOutput("TeXcount failed")).toThrow(/expected report/);
  });

  it("feeds selected source exactly once to each TeXcount pass, never after close", async () => {
    const inputs: ReturnType<typeof vi.fn>[] = [];
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { on: vi.fn(), end: vi.fn() }
      });
      const version = args?.includes("--version");
      if (!version) inputs.push(child.stdin.end);
      queueMicrotask(() => {
        const kind = args?.includes("-char") ? "CHARS" : "WORDS";
        child.stdout.emit("data", Buffer.from(version ? "TeXcount fixture" : `__TEXLITE_TEXCOUNT_${kind}__|3|0|0|0|0|0|0`));
        child.emit("close", 0);
      });
      return child as never;
    });
    const service = new TexcountService();
    await expect(service.countSource(".", "selected source")).resolves.toMatchObject({ totalWords: 3 });
    expect(inputs).toHaveLength(2);
    for (const end of inputs) expect(end).toHaveBeenCalledExactlyOnceWith("selected source", "utf8");
    await service.dispose();
  });
});
