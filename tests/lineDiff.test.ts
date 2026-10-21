import { describe, expect, it } from "vitest";
import { makeLineDiff } from "../src/client/lineDiff";

describe("line-oriented diffs", () => {
  it("replaces complete lines instead of exposing shared character fragments", () => {
    expect(makeLineDiff("first\nold paragraph\nlast\n", "first\nnew paragraph\nlast\n")).toEqual([
      [0, "first\n"], [-1, "old paragraph\n"], [1, "new paragraph\n"], [0, "last\n"]
    ]);
  });

  it.each([
    ["", ""], ["", "new\n\nlast"], ["old\n\nlast", ""],
    ["one\n", "one"], ["one\r\ntwo\r\n", "one\r\nnew\r\n"],
    ["中文 😀\nrepeat\nrepeat\n末行", "中文 😁\nrepeat\nnew\nrepeat\n末行"]
  ])("preserves both inputs exactly: %j -> %j", (before, after) => {
    const diffs = makeLineDiff(before, after);
    expect(diffs.filter(([op]) => op !== 1).map(([, text]) => text).join("")).toBe(before);
    expect(diffs.filter(([op]) => op !== -1).map(([, text]) => text).join("")).toBe(after);
  });

  it("keeps large files lossless across surrogate-token and token-capacity boundaries", () => {
    const before = Array.from({ length: 70_000 }, (_, index) => `line ${index}\n`).join("");
    const after = before.replace("line 1\n", "changed 1\n").replace("line 69999\n", "changed last\n");
    const diffs = makeLineDiff(before, after);
    expect(diffs.filter(([op]) => op !== 1).map(([, text]) => text).join("")).toBe(before);
    expect(diffs.filter(([op]) => op !== -1).map(([, text]) => text).join("")).toBe(after);
    expect(makeLineDiff(before, before)).toEqual([[0, before]]);
  });
});
