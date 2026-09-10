import { describe, expect, it } from "vitest";
import { buildOutlineTree, outlineItemKey, visibleOutlineTreeItems } from "../src/client/workspace/outlineTree";
import type { ProjectOutlineItem } from "../src/client/workspace/types";

describe("workspace outline folding", () => {
  const outline: ProjectOutlineItem[] = [
    { path: "main.tex", line: 1, level: 1, title: "Introduction" },
    { path: "main.tex", line: 5, level: 2, title: "Motivation" },
    { path: "main.tex", line: 9, level: 3, title: "Prior work" },
    { path: "main.tex", line: 15, level: 1, title: "Method" },
    { path: "main.tex", line: 20, level: 2, title: "Setup" }
  ];

  it("derives nested headings from the flat project outline", () => {
    const tree = buildOutlineTree(outline);
    expect(tree.map((entry) => entry.hasChildren)).toEqual([true, true, false, true, false]);
    expect(tree[2].ancestorKeys).toEqual([outlineItemKey(outline[0]), outlineItemKey(outline[1])]);
  });

  it("hides every descendant of a collapsed heading without hiding its siblings", () => {
    const tree = buildOutlineTree(outline);
    const collapsed = new Set([outlineItemKey(outline[0])]);
    expect(visibleOutlineTreeItems(tree, collapsed).map((entry) => entry.item.title))
      .toEqual(["Introduction", "Method", "Setup"]);
  });
});
