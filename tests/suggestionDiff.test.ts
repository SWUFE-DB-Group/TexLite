import { describe, expect, it } from "vitest";
import { makeSuggestionDiff } from "../src/client/workspace/suggestionDiff";

describe("word-level suggestion previews", () => {
  it("shows complete changed words instead of highlighting only a suffix", () => {
    const diff = makeSuggestionDiff("The method outperforms baselines.", "The method can outperform baselines.");
    expect(diff.filter(([kind]) => kind === -1).map(([, text]) => text).join("")).toContain("outperforms");
    expect(diff.filter(([kind]) => kind === 1).map(([, text]) => text).join("")).toContain("outperform");
  });

  it.each([
    ["中文批注与原文。", "中文批注和原文。"],
    ["A 😀 example\r\n\\cite{key_a, key_b}", "An 😀 example\r\n\\cite{key_a, key_c}"],
    ["text\n\n\twith  spaces", "text\n\n\twith three spaces"],
    ["Original text", ""], ["", "New text"], ["Unchanged", "Unchanged"]
  ])("preserves both source strings exactly (%j → %j)", (before, after) => {
    const diff = makeSuggestionDiff(before, after);
    expect(diff.filter(([kind]) => kind !== 1).map(([, text]) => text).join("")).toBe(before);
    expect(diff.filter(([kind]) => kind !== -1).map(([, text]) => text).join("")).toBe(after);
  });
});
