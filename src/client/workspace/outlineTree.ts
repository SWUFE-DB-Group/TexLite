import type { ProjectOutlineItem } from "./types";

export interface OutlineTreeItem {
  item: ProjectOutlineItem;
  key: string;
  ancestorKeys: string[];
  hasChildren: boolean;
}

export function outlineItemKey(item: ProjectOutlineItem): string {
  return `${item.path}\u0000${item.line}`;
}

/**
 * The project outline is a depth-first flat list. Preserve that compact wire
 * format while deriving the parent chain needed for UI-only folding.
 */
export function buildOutlineTree(outline: ProjectOutlineItem[]): OutlineTreeItem[] {
  const tree: OutlineTreeItem[] = [];
  const ancestors: Array<{ level: number; index: number }> = [];

  for (const item of outline) {
    while (ancestors.length && ancestors.at(-1)!.level >= item.level) ancestors.pop();
    const parent = ancestors.at(-1);
    if (parent) tree[parent.index].hasChildren = true;
    tree.push({
      item,
      key: outlineItemKey(item),
      ancestorKeys: ancestors.map(({ index }) => tree[index].key),
      hasChildren: false
    });
    ancestors.push({ level: item.level, index: tree.length - 1 });
  }
  return tree;
}

export function visibleOutlineTreeItems(tree: OutlineTreeItem[], collapsedKeys: ReadonlySet<string>): OutlineTreeItem[] {
  return tree.filter((entry) => !entry.ancestorKeys.some((key) => collapsedKeys.has(key)));
}
