import { describe, expect, it } from "vitest";
import { collectAgentChanges, mapPosition, mapRange, type AgentChangeStep } from "../src/server/agentChanges.js";
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
});
