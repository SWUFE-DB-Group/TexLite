import { describe, expect, it } from "vitest";
import { collectAgentChanges, mapPosition, mapRange, normalizeAgentChangeLineEndings, type AgentChangeStep } from "../src/server/agentChanges.js";
import { createEditHistorySpan, type EditHistorySpan } from "../src/server/editHistory.js";

/** One step replacing `deleted` at `at` with `inserted`. */
function replace(id: string, agent: boolean, before: string, deleted: string, inserted: string, at = before.indexOf(deleted)): { step: AgentChangeStep; after: string } {
  if (at < 0) throw new Error(`"${deleted}" not in "${before}"`);
  return {
    step: { id, agent, createdAt: `2026-01-01T10:00:0${id.length % 10}.000Z`, spans: [createEditHistorySpan(at, at, deleted, inserted)] },
    after: before.slice(0, at) + inserted + before.slice(at + deleted.length)
  };
}

const span = (beforeStart: number, afterStart: number, deleted: string, inserted: string): EditHistorySpan =>
  createEditHistorySpan(beforeStart, afterStart, deleted, inserted);

describe("mapping agent ranges forward", () => {
  it("shifts positions after a replacement and never absorbs an insertion at a range edge", () => {
    const spans = [span(2, 2, "", "XY")];
    expect(mapPosition(1, spans, "start")).toBe(1);
    expect(mapPosition(2, spans, "start")).toBe(4);
    expect(mapPosition(2, spans, "end")).toBe(2);
    expect(mapRange({ from: 2, to: 5 }, spans)).toEqual([{ from: 4, to: 7 }]);
    expect(mapRange({ from: 0, to: 2 }, spans)).toEqual([{ from: 0, to: 2 }]);
  });

  it("drops replaced text and splits a range around text inserted inside it", () => {
    // "abcdef" with the agent range "bcde" (1..5).
    expect(mapRange({ from: 1, to: 5 }, [span(2, 2, "cd", "Z")])).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
    expect(mapRange({ from: 1, to: 5 }, [span(3, 3, "", "!!")])).toEqual([{ from: 1, to: 3 }, { from: 5, to: 7 }]);
    expect(mapRange({ from: 1, to: 5 }, [span(0, 0, "abcdef", "new")])).toEqual([]);
  });
});

describe("collecting agent changes", () => {
  it("reports an agent replacement with a line diff and ignores direct edits", () => {
    let source = "Intro line.\nThe result is good.\nEnd.\n";
    const direct = replace("d1", false, source, "Intro", "Opening");
    source = direct.after;
    const agent = replace("a1", true, source, "good", "significant");
    source = agent.after;
    const [change] = collectAgentChanges([direct.step, agent.step], source);
    expect(change).toMatchObject({
      id: "a1:0", ids: ["a1:0"], line: 2, anchors: [], afterFrom: source.indexOf("The result"),
      before: "The result is good.", after: "The result is significant."
    });
    expect(source.slice(change.pieces[0].from, change.pieces[0].to)).toBe("significant");
    expect(collectAgentChanges([direct.step], source)).toEqual([]);
  });

  it("follows later edits: shifts with text added before, shrinks when a person edits it, and vanishes when replaced", () => {
    let source = "alpha beta gamma";
    const agent = replace("a1", true, source, "beta", "BETA TEXT");
    source = agent.after;
    const before = replace("h1", false, source, "alpha", "alpha alpha");
    source = before.after;
    let [change] = collectAgentChanges([agent.step, before.step], source);
    expect(source.slice(change.from, change.to)).toBe("BETA TEXT");

    const trim = replace("h2", false, source, "TEXT", "words");
    source = trim.after;
    [change] = collectAgentChanges([agent.step, before.step, trim.step], source);
    expect(change.pieces.map((piece) => source.slice(piece.from, piece.to))).toEqual(["BETA "]);
    // The agent's text no longer stands as written, so no misleading preview.
    expect(change.before).toBeNull();

    const gone = replace("h3", false, source, "BETA ", "");
    expect(collectAgentChanges([agent.step, before.step, trim.step, gone.step], gone.after)).toEqual([]);
  });

  it("groups nearby replacements from one write, keeps separate writes apart, and marks pure deletions", () => {
    // "one two three\n\nfour five" -> "ONE two 3\n\nfive"
    const write: AgentChangeStep = {
      id: "a1", agent: true, createdAt: "2026-01-01T10:00:00.000Z",
      spans: [span(0, 0, "one", "ONE"), span(8, 8, "three", "3"), span(15, 11, "four ", "")]
    };
    const afterWrite = "ONE two 3\n\nfive";
    const later = replace("a2", true, afterWrite, "five", "5");
    const changes = collectAgentChanges([write, later.step], later.after);
    expect(changes.map((change) => change.ids)).toEqual([["a1:0", "a1:1"], ["a1:2"], ["a2:0"]]);
    expect(changes[0]).toMatchObject({ before: "one two three", after: "ONE two 3" });
    expect(changes[1]).toMatchObject({ pieces: [], anchors: [11] });
  });

  const write = (id: string, spans: EditHistorySpan[]): AgentChangeStep => ({ id, agent: true, createdAt: "2026-01-01T10:00:00.000Z", spans });

  it("highlights whole words across a character-level rewrite, and joins them over spaces only", () => {
    // "a paper here, ok" from "a pxxer there, ok": the diff kept scattered letters.
    const source = "a paper here, ok";
    const [change] = collectAgentChanges([write("a", [span(2, 2, "", "p"), span(4, 4, "xx", "pe"), span(8, 8, "t", ""), span(12, 12, "", ",")])], source);
    expect(change.pieces.map((piece) => source.slice(piece.from, piece.to))).toEqual(["paper", ","]);
    expect(source.slice(change.from, change.to)).toBe("paper here,");
  });

  it("does not stretch a highlight over a run of CJK text or across a word it only touches", () => {
    const cjk = "这是一段中文";
    const [inCjk] = collectAgentChanges([write("a", [span(2, 2, "", "一")])], cjk);
    expect(inCjk.pieces.map((piece) => cjk.slice(piece.from, piece.to))).toEqual(["一"]);
    const punctuation = "word, next";
    const [comma] = collectAgentChanges([write("b", [span(4, 4, "", ",")])], punctuation);
    expect(comma.pieces.map((piece) => punctuation.slice(piece.from, piece.to))).toEqual([","]);
  });

  it("joins words only while each still stands as written", () => {
    let source = "new text";
    const agent = write("a", [span(0, 0, "", "new"), span(3, 4, "", "text")]);
    const human = replace("h", false, source, "ext", "EXT");
    source = human.after;
    const [change] = collectAgentChanges([agent, human.step], source);
    expect(change.pieces.map((piece) => source.slice(piece.from, piece.to))).toEqual(["new", "t"]);
  });

  it("drops a deletion once its text is put back, and offers no preview after other text lands there", () => {
    const deletion = write("a", [span(0, 0, "XYZ ", "")]);
    const restored = replace("h", false, "rest", "", "XYZ ", 0);
    expect(collectAgentChanges([deletion, restored.step], restored.after)).toEqual([]);
    const other = replace("h", false, "rest", "", "ABC ", 0);
    const [change] = collectAgentChanges([deletion, other.step], other.after);
    expect(change).toMatchObject({ before: null, anchors: [0] });
  });

  it("starts the preview at the file's start when the file opens with a newline", () => {
    const source = "\nAB\nrest";
    const [change] = collectAgentChanges([write("a", [span(0, 0, "", "\nAB")])], source);
    expect(change).toMatchObject({ afterFrom: 0, before: "", after: "\nAB" });
  });

  it("expresses results in the editor's line endings", () => {
    const content = "one\r\ntwo\r\nthree\r\n";
    const [change] = collectAgentChanges([write("a", [span(5, 5, "old", "two")])], content);
    const { source, changes } = normalizeAgentChangeLineEndings([change], content);
    expect(source).toBe("one\ntwo\nthree\n");
    expect(source.slice(changes[0].pieces[0].from, changes[0].pieces[0].to)).toBe("two");
    expect(changes[0]).toMatchObject({ line: 2, afterFrom: 4, after: "two" });
    const plain = "no carriage returns";
    expect(normalizeAgentChangeLineEndings([change], plain).source).toBe(plain);
  });
});
