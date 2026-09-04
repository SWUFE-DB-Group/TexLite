import diff_match_patch from "diff-match-patch";

export interface UnifiedDiffResult {
  diffText: string;
  additions: number;
  deletions: number;
  hasChanges: boolean;
}

interface DiffLine {
  op: number;
  text: string;
  oldNum: number;
  newNum: number;
}

export function generateUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
  oldLabel = "历史版本",
  newLabel = "当前版本",
  contextLines = 3
): UnifiedDiffResult {
  const normalizedOld = oldText.replace(/\r\n/g, "\n");
  const normalizedNew = newText.replace(/\r\n/g, "\n");

  if (normalizedOld === normalizedNew) {
    return { diffText: "", additions: 0, deletions: 0, hasChanges: false };
  }

  const dmp = new diff_match_patch();
  const lineData = dmp.diff_linesToChars_(normalizedOld, normalizedNew);
  const diffs = dmp.diff_main(lineData.chars1, lineData.chars2, false);
  dmp.diff_charsToLines_(diffs, lineData.lineArray);

  const lines: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  let additions = 0;
  let deletions = 0;

  for (const [op, chunk] of diffs) {
    if (!chunk) continue;
    const split = chunk.split("\n");
    if (split[split.length - 1] === "") split.pop();
    for (const text of split) {
      if (op === 0) {
        lines.push({ op: 0, text, oldNum: oldNum++, newNum: newNum++ });
      } else if (op === -1) {
        deletions++;
        lines.push({ op: -1, text, oldNum: oldNum++, newNum });
      } else if (op === 1) {
        additions++;
        lines.push({ op: 1, text, oldNum, newNum: newNum++ });
      }
    }
  }

  if (additions === 0 && deletions === 0) {
    return { diffText: "", additions: 0, deletions: 0, hasChanges: false };
  }

  const hunks: Array<{ start: number; end: number }> = [];
  let hunkStart = -1;
  let hunkEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op !== 0) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      if (hunkStart === -1) {
        hunkStart = start;
        hunkEnd = end;
      } else if (start <= hunkEnd + 1) {
        hunkEnd = Math.max(hunkEnd, end);
      } else {
        hunks.push({ start: hunkStart, end: hunkEnd });
        hunkStart = start;
        hunkEnd = end;
      }
    }
  }
  if (hunkStart !== -1) {
    hunks.push({ start: hunkStart, end: hunkEnd });
  }

  const result: string[] = [
    `--- a/${filePath} (${oldLabel})`,
    `+++ b/${filePath} (${newLabel})`
  ];

  for (const hunk of hunks) {
    const hunkLines = lines.slice(hunk.start, hunk.end + 1);
    const oldCount = hunkLines.filter((l) => l.op <= 0).length;
    const newCount = hunkLines.filter((l) => l.op >= 0).length;
    const firstLine = hunkLines[0];
    const oldStart = oldCount === 0 ? 0 : firstLine.oldNum;
    const newStart = newCount === 0 ? 0 : firstLine.newNum;

    result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of hunkLines) {
      const prefix = l.op === -1 ? "-" : l.op === 1 ? "+" : " ";
      result.push(`${prefix}${l.text}`);
    }
  }

  return {
    diffText: result.join("\n"),
    additions,
    deletions,
    hasChanges: true
  };
}

export function formatCommitTime(isoString: string, lang?: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    const now = new Date();
    const isSameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (isSameDay) {
      return date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleString(lang, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoString;
  }
}

export interface VersionTitleTarget {
  label: string | null;
  reason?: string;
  createdAt: string;
  changedPaths: string[];
  author?: { name?: string; username?: string } | null;
}

export function formatVersionTitle(
  version: VersionTitleTarget,
  defaultTitle: string,
  lang?: string
): string {
  if (version.label) return version.label;
  const time = formatCommitTime(version.createdAt, lang);
  if (version.changedPaths.length === 1) {
    const fileName = version.changedPaths[0].split("/").pop() || version.changedPaths[0];
    return `${fileName} (${time})`;
  }
  if (version.changedPaths.length === 2) {
    const f1 = version.changedPaths[0].split("/").pop() || version.changedPaths[0];
    const f2 = version.changedPaths[1].split("/").pop() || version.changedPaths[1];
    return `${f1}, ${f2} (${time})`;
  }
  if (version.changedPaths.length > 2) {
    const f1 = version.changedPaths[0].split("/").pop() || version.changedPaths[0];
    return `${f1} +${version.changedPaths.length - 1} (${time})`;
  }
  const author = version.author?.name || version.author?.username;
  if (author) {
    return `${author} @ ${time}`;
  }
  return `${defaultTitle} (${time})`;
}

