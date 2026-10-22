import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { sortProjectCommentsBySource } from "../src/server/commentSourceOrder.js";

let root: string, source: string, config: Config;
const projectId = "reading-order";
let corpus: Map<string, string>;

function write(filePath: string, text: string) {
  const absolute = path.join(source, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
  corpus.set(filePath, text);
}
function comment(id: string, filePath: string, marker: string = id) {
  const text = corpus.get(filePath) ?? "";
  const startOffset = text.indexOf(marker);
  if (startOffset < 0) throw new Error(`Missing test marker ${marker} in ${filePath}`);
  return { id, filePath, startOffset, startLine: text.slice(0, startOffset).split("\n").length,
    createdAt: "2026-10-22T00:00:00Z" };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-comment-order-"));
  config = { projectsDir: path.join(root, "projects") } as Config;
  source = path.join(config.projectsDir, projectId, "source");
  fs.mkdirSync(source, { recursive: true });
  corpus = new Map();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("project comment manuscript order", () => {
  it("does not scan the project when every discussion belongs to one file", async () => {
    write("main.tex", "first\nsecond");
    const directoryRead = vi.spyOn(fs.promises, "readdir"), contentRead = vi.spyOn(fs.promises, "readFile");
    const input = [comment("second", "main.tex"), comment("first", "main.tex")];
    expect((await sortProjectCommentsBySource(config, projectId, "main.tex", input)).map(({ id }) => id))
      .toEqual(["first", "second"]);
    expect(directoryRead).not.toHaveBeenCalled();
    expect(contentRead).not.toHaveBeenCalled();
  });

  it("interleaves main-file notes and nested includes instead of grouping files or using breadth-first order", async () => {
    write("main.tex", "before\n\\input{z-intro}\nmiddle\n\\include{a-method}\nafter\n");
    write("z-intro.tex", "intro-before\n\\input nested\nintro-after\n");
    write("nested.tex", "nested-note");
    write("a-method.tex", "method-note");
    const input = [comment("after", "main.tex"), comment("method-note", "a-method.tex"),
      comment("intro-after", "z-intro.tex"), comment("nested-note", "nested.tex"),
      comment("middle", "main.tex"), comment("before", "main.tex"), comment("intro-before", "z-intro.tex"),
      comment("include-note", "main.tex", "\\input")];
    const original = structuredClone(input);
    const sorted = await sortProjectCommentsBySource(config, projectId, "main.tex", input);
    expect(sorted.map(({ id }) => id)).toEqual([
      "before", "include-note", "intro-before", "nested-note", "intro-after", "middle", "method-note", "after"
    ]);
    expect(sorted.map(({ sourceOrder }) => sourceOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(input).toEqual(original);
  });

  it("uses the first occurrence of repeated files and terminates cycles", async () => {
    write("main.tex", "before\n\\input{child}\nbetween\n\\input{child}\nafter");
    write("child.tex", "child-before\n\\input{main}\nchild-after");
    const input = [comment("after", "main.tex"), comment("child-after", "child.tex"),
      comment("between", "main.tex"), comment("child-before", "child.tex"), comment("before", "main.tex")];
    const sorted = await sortProjectCommentsBySource(config, projectId, "main.tex", input);
    expect(sorted.map(({ id }) => id)).toEqual(["before", "child-before", "child-after", "between", "after"]);
    expect(new Set(sorted.map(({ id }) => id)).size).toBe(input.length);
  });

  it("shares import/subimport/subfile path resolution, including ordinary inputs inside imported files", async () => {
    write("main.tex", "start\n\\import{chapters/}{intro}\n\\subfile{appendix/overview}\nfinal-note");
    write("chapters/intro.tex", "intro\n\\input{method}\n\\subimport{nested/}{proof}\n");
    write("chapters/method.tex", "method");
    write("method.tex", "wrong-root");
    write("chapters/nested/proof.tex", "proof\n\\input{detail}");
    write("chapters/nested/detail.tex", "detail");
    write("appendix/overview.tex", "overview\n\\input{detail}");
    write("appendix/detail.tex", "appendix-detail");
    const input = [comment("wrong-root", "method.tex"), comment("end", "main.tex", "final-note"),
      comment("appendix-detail", "appendix/detail.tex"), comment("overview", "appendix/overview.tex"),
      comment("detail", "chapters/nested/detail.tex"), comment("proof", "chapters/nested/proof.tex"),
      comment("method", "chapters/method.tex"), comment("intro", "chapters/intro.tex"), comment("start", "main.tex")];
    expect((await sortProjectCommentsBySource(config, projectId, "main.tex", input)).map(({ id }) => id))
      .toEqual(["start", "intro", "method", "proof", "detail", "overview", "appendix-detail", "end", "wrong-root"]);
  });

  it("ignores commented, literal and macro-based includes and appends unrelated notes in natural file order", async () => {
    write("main.tex", ["start", "% \\input{notes2}", "\\verb|\\input{notes10}|",
      "\\begin{verbatim}", "\\input{notes2}", "\\end{verbatim}", "\\input{chapters\\chosen}",
      "\\input{missing}", "\\input{included}", "final-note"].join("\n"));
    write("notes10.tex", "ten"); write("notes2.tex", "two");
    write("chapters/chosen.tex", "dynamic"); write("included.tex", "included");
    const input = [comment("ten", "notes10.tex"), comment("two", "notes2.tex"),
      comment("dynamic", "chapters/chosen.tex"), comment("included", "included.tex"),
      comment("end", "main.tex", "final-note"), comment("start", "main.tex")];
    expect((await sortProjectCommentsBySource(config, projectId, "main.tex", input)).map(({ id }) => id))
      .toEqual(["start", "included", "end", "dynamic", "two", "ten"]);
  });

  it("reuses source already read for anchor positions but reads unannotated include parents when necessary", async () => {
    write("main.tex", "before\n\\input{parent}\nafter");
    write("parent.tex", "\\input{child}");
    write("child.tex", "child");
    const input = [comment("after", "main.tex"), comment("child", "child.tex"), comment("before", "main.tex")];
    const cached = new Map([ ["main.tex", corpus.get("main.tex")!], ["child.tex", "child"] ]);
    const read = vi.spyOn(fs.promises, "readFile");
    expect((await sortProjectCommentsBySource(config, projectId, "main.tex", input, cached)).map(({ id }) => id))
      .toEqual(["before", "child", "after"]);
    expect(read).toHaveBeenCalledExactlyOnceWith(path.join(source, "parent.tex"));
  });

  it("recomputes order when includes or the configured main document change", async () => {
    write("main.tex", "\\input{a}\n\\input{b}");
    write("other.tex", "\\input{b}\n\\input{a}");
    write("a.tex", "a"); write("b.tex", "b");
    const input = [comment("a", "a.tex"), comment("b", "b.tex")];
    const ids = async (root: string) => (await sortProjectCommentsBySource(config, projectId, root, input)).map(({ id }) => id);
    expect(await ids("main.tex")).toEqual(["a", "b"]);
    expect(await ids("other.tex")).toEqual(["b", "a"]);
    write("main.tex", "\\input{b}\n\\input{a}");
    expect(await ids("main.tex")).toEqual(["b", "a"]);
  });

  it.each(["", "missing.tex"])("falls back without losing comments when root %j is unavailable", async (mainFile) => {
    write("notes2.tex", "first\nsecond"); write("notes10.tex", "ten");
    const input = [comment("ten", "notes10.tex"), comment("second", "notes2.tex"), comment("first", "notes2.tex")];
    expect((await sortProjectCommentsBySource(config, projectId, mainFile, input)).map(({ id }) => id))
      .toEqual(["first", "second", "ten"]);
  });

  it("keeps oversized and missing sources as fallback discussions rather than failing the review", async () => {
    write("main.tex", "before\n\\input{oversized}\n\\input{missing}\nafter");
    write("oversized.tex", "oversized" + " ".repeat(3 * 1024 * 1024));
    write("missing.tex", "missing");
    const input = [comment("oversized", "oversized.tex"), comment("missing", "missing.tex"),
      comment("after", "main.tex"), comment("before", "main.tex")];
    fs.unlinkSync(path.join(source, "missing.tex"));
    expect((await sortProjectCommentsBySource(config, projectId, "main.tex", input)).map(({ id }) => id))
      .toEqual(["before", "after", "missing", "oversized"]);
  });

  it("bounds nested traversal and still returns notes beyond the visit budget", async () => {
    for (let index = 0; index <= 200; index++) write(`part${index}.tex`, `note${index}\n\\input{part${index + 1}}`);
    const input = [comment("last", "part200.tex", "note200"), comment("first", "part0.tex", "note0")];
    const read = vi.spyOn(fs.promises, "readFile");
    expect((await sortProjectCommentsBySource(config, projectId, "part0.tex", input)).map(({ id }) => id))
      .toEqual(["first", "last"]);
    expect(read).toHaveBeenCalledTimes(200);
    expect(read).not.toHaveBeenCalledWith(path.join(source, "part200.tex"));
  });
});
