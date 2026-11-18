import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectPdfFonts, parsePdfFonts } from "../src/server/pdfFonts";
import { stopProcessTree } from "../src/server/processTree";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/server/processTree", () => ({ detachedProcessGroup: () => true, afterProcessStop: (_child: EventEmitter, complete: () => void) => complete(),
  stopProcessTree: vi.fn(async (child: EventEmitter) => { child.emit("close", null); }) }));

const header = "name                                 type              encoding         emb sub uni object ID\n------------------------------------ ----------------- ---------------- --- --- --- ---------\n";
const row = "ABCDEF+Noto Sans                      CID TrueType      Identity-H       yes yes yes     15  0\n";
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(spawn).mockReset(); vi.mocked(stopProcessTree).mockClear();
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as never);
});
afterEach(() => { vi.useRealTimers(); });

describe("PDF font inspection", () => {
  it("parses spaced font names, CFF/OpenType variants and flags without mistaking CID for an issue", () => {
    expect(parsePdfFonts(header + row + [
      "[none] Type 3 Custom yes no no 16 0",
      "Helvetica Type 1 WinAnsi no no no 17 0",
      "FontName Type 1C (OT) Custom yes yes no 18 0",
      "CJKFont CID Type 0C (OT) Identity-H yes yes yes 19 0",
      "OtherFont CID Type 0 Identity-H yes no no 20 0",
      "Unknown unknown Custom no no no 21 0"
    ].join("\r\n"))).toEqual([
      { name: "ABCDEF+Noto Sans", type: "CID TrueType", encoding: "Identity-H", embedded: true, subset: true, unicode: true },
      { name: "[none]", type: "Type 3", encoding: "Custom", embedded: true, subset: false, unicode: false },
      { name: "Helvetica", type: "Type 1", encoding: "WinAnsi", embedded: false, subset: false, unicode: false },
      { name: "FontName", type: "Type 1C (OT)", encoding: "Custom", embedded: true, subset: true, unicode: false },
      { name: "CJKFont", type: "CID Type 0C (OT)", encoding: "Identity-H", embedded: true, subset: true, unicode: true },
      { name: "OtherFont", type: "CID Type 0", encoding: "Identity-H", embedded: true, subset: false, unicode: false },
      { name: "Unknown", type: "unknown", encoding: "Custom", embedded: false, subset: false, unicode: false }
    ]);
    expect(parsePdfFonts(header)).toEqual([]);
    for (const invalid of ["", "Unable to read PDF", header + "truncated font row"]) {
      expect(() => parsePdfFonts(invalid)).toThrow(expect.objectContaining({ code: "PDF_FONTS_FAILED" }));
    }
  });

  it("runs the fixed optional tool without a shell and does not leak stderr paths", async () => {
    const result = inspectPdfFonts("/private/project/main.pdf");
    expect(spawn).toHaveBeenCalledWith("pdffonts", ["/private/project/main.pdf"], expect.objectContaining({
      shell: false, env: expect.objectContaining({ LC_ALL: "C" })
    }));
    child.stdout.write(header + row); child.stderr.write("Syntax Warning: /private/font path"); child.emit("close", 0);
    expect(await result).toEqual({ fonts: parsePdfFonts(header + row), hasWarnings: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a missing optional executable, and permits a later successful retry", async () => {
    const first = inspectPdfFonts("/private/main.pdf");
    child.emit("error", Object.assign(new Error("spawn pdffonts ENOENT"), { code: "ENOENT" }));
    await expect(first).rejects.toMatchObject({ code: "PDF_FONTS_UNAVAILABLE", statusCode: 503 });
    const retry = inspectPdfFonts("/private/main.pdf");
    child.stdout.write(header); child.emit("close", 0);
    await expect(retry).resolves.toMatchObject({ fonts: [] });
  });

  it("does not treat a failed process with plausible output as a successful inspection", async () => {
    const result = inspectPdfFonts("/private/main.pdf");
    child.stdout.write(header + row); child.emit("close", 1);
    await expect(result).rejects.toMatchObject({ code: "PDF_FONTS_FAILED", statusCode: 422 });
  });

  it("kills work on cancellation and never starts already-cancelled requests", async () => {
    const controller = new AbortController();
    const result = inspectPdfFonts("/private/main.pdf", controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(stopProcessTree).toHaveBeenCalledWith(child);
    await expect(inspectPdfFonts("/private/main.pdf", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds runtime and both output streams", async () => {
    const result = inspectPdfFonts("/private/main.pdf");
    const rejected = expect(result).rejects.toMatchObject({ code: "PDF_FONTS_FAILED" });
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(stopProcessTree).toHaveBeenCalledWith(child);
    for (const stream of ["stdout", "stderr"] as const) {
      const next = inspectPdfFonts("/private/main.pdf");
      child[stream].write(Buffer.alloc(1024 * 1024 + 1));
      await expect(next).rejects.toMatchObject({ code: "PDF_FONTS_FAILED" });
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
