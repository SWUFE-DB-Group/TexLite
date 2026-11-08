import { describe, expect, it } from "vitest";
import { textReplacements } from "../src/shared/textDiff";

const apply = (before: string, replacements: ReturnType<typeof textReplacements>) =>
  [...replacements].reverse().reduce((text, { from, to, insert }) => text.slice(0, from) + insert + text.slice(to), before);

describe("text replacements", () => {
  it.each([
    ["", "new"], ["old", ""], ["same", "same"], ["Hello   world", "Hello world"],
    ["line one\nline two\n", "line one\nline 2\nline three\n"], ["前 😀 后", "前 😁 后"]
  ])("turns %j into %j with ordered replacements on the original text", (before, after) => {
    for (const cleanup of [undefined, "efficiency", "semantic"] as const) {
      const replacements = textReplacements(before, after, cleanup);
      expect(apply(before, replacements)).toBe(after);
      replacements.forEach((replacement, index) => {
        expect(replacement.from).toBeLessThanOrEqual(replacement.to);
        if (index > 0) expect(replacement.from).toBeGreaterThanOrEqual(replacements[index - 1].to);
      });
    }
    expect(textReplacements("same", "same")).toEqual([]);
  });

  it("keeps exact minimal edits without cleanup", () => {
    expect(textReplacements("abXcd", "xyXzw")).toEqual([{ from: 0, to: 2, insert: "xy" }, { from: 3, to: 5, insert: "zw" }]);
  });
});
