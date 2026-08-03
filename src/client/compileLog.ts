export interface CompileMessages {
  warnings: string[];
  errors: string[];
}

export type CompileOutcome = "succeeded" | "failed" | null;

export function classifyCompileLog(log: string, outcome: CompileOutcome = null): CompileMessages {
  const lines = normalizedLines(log);
  // The process result is authoritative.  A successful latexmk log may contain
  // error-looking text in package names, command-line flags, or an earlier pass.
  const succeeded = outcome === "succeeded" || (outcome === null && hasSuccessfulLatexmkResult(log));
  const errors = succeeded ? [] : unique(lines.filter(isErrorLine));

  // latexmk intentionally runs LaTeX several times.  Warnings such as an
  // undefined citation from the first pass are transient once BibTeX/Biber and
  // the final LaTeX pass have completed, so only expose final-pass warnings.
  const warningLines = normalizedLines(finalLatexPass(log));
  const warnings = unique(warningLines.filter((line) => !isErrorLine(line) && isWarningLine(line)));
  return { warnings, errors };
}

function normalizedLines(log: string): string[] {
  return log.split("\n").map((line) => line.trim()).filter(Boolean);
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}

function finalLatexPass(log: string): string {
  const invocation = /^Running ['"][^\n]*(?:pdf|xe|lua)latex(?:\s|['"])[^\n]*$/gim;
  let start = -1;
  for (const match of log.matchAll(invocation)) start = match.index;
  return start >= 0 ? log.slice(start) : log;
}

function hasSuccessfulLatexmkResult(log: string): boolean {
  return /Latexmk: All targets .* are up-to-date/i.test(log)
    && /Output written on .*\.pdf/i.test(log);
}

function isErrorLine(line: string): boolean {
  return /^!\s/.test(line)
    || /(?:^|:\s)(?:LaTeX|Package|Class|pdfTeX|XeTeX|LuaTeX)?\s*Error:/i.test(line)
    || /^Latexmk:.*(?:\bErrors?,|did not complete making targets|failure)/i.test(line)
    || /^Collected error summary/i.test(line)
    || /\b(?:fatal error|emergency stop|undefined control sequence|no output pdf|no pages of output)\b/i.test(line)
    || /\b(?:bibtex|biber) errors?:/i.test(line)
    || /^error, and then rerun latexmk/i.test(line);
}

function isWarningLine(line: string): boolean {
  return /\bwarnings?\b|overfull|underfull|badness/i.test(line);
}
