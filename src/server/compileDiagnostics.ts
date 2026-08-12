/**
 * A bounded, machine-readable view of a latexmk transcript.
 *
 * The process result is deliberately passed to the parser.  latexmk runs
 * several tools and may print an error-looking message from an intermediate
 * pass even when the final PDF was produced successfully.  The exit/result
 * status is therefore authoritative for the error list; the transcript is
 * still retained separately for users who need all details.
 */

export type CompileDiagnosticSeverity = "warning" | "error";
export type CompileDiagnosticPhase = "pdflatex" | "xelatex" | "lualatex" | "bibtex" | "biber" | "latexmk" | "system" | "unknown";
export type CompileDiagnosticOutcome = "succeeded" | "failed" | null;

export interface CompileDiagnostic {
  severity: CompileDiagnosticSeverity;
  phase: CompileDiagnosticPhase;
  message: string;
  raw: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface CompileDiagnostics {
  warnings: CompileDiagnostic[];
  errors: CompileDiagnostic[];
}

interface MutableDiagnostic extends CompileDiagnostic {
  key: string;
  latexPass?: number;
}

const commandPattern = /\b(pdflatex|xelatex|lualatex|bibtex|biber)\b/i;
const locationPattern = /^(?<file>[^:\n]+):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<rest>.*)$/;
const inputLinePattern = /\bon input line (?<line>\d+)\b/i;
const latexLinePattern = /^l\.(?<line>\d+)\b/;

export function parseCompileDiagnostics(log: string, outcome: CompileDiagnosticOutcome = null): CompileDiagnostics {
  const lines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const resolvedOutcome: CompileDiagnosticOutcome = outcome ?? (hasSuccessfulLatexmkResult(log) ? "succeeded" : null);
  const diagnostics: MutableDiagnostic[] = [];
  let phase: CompileDiagnosticPhase = "unknown";
  let currentFile: string | undefined;
  let pendingBang: MutableDiagnostic | undefined;
  let latexPass = 0;
  let lastLatexPass = 0;

  for (const line of lines) {
    const command = line.match(commandPattern);
    if (/^Running\s+['"]?/i.test(line) && command) {
      phase = command[1].toLowerCase() as CompileDiagnosticPhase;
      if (phase === "pdflatex" || phase === "xelatex" || phase === "lualatex") {
        latexPass += 1;
        lastLatexPass = latexPass;
      }
      const texArgument = [...line.matchAll(/(?:['"]|\s)([^\s'"]+\.tex)(?:['"]|\s|$)/gi)].at(-1)?.[1];
      if (texArgument) currentFile = texArgument.replaceAll("\\", "/");
      pendingBang = undefined;
      continue;
    }
    if (/^Latexmk:/i.test(line)) phase = "latexmk";

    const located = parseLocatedLine(line);
    if (located) {
      currentFile = located.file ?? currentFile;
      const severity = located.severity;
      if (severity) {
        addDiagnostic(diagnostics, {
          severity,
          phase,
          message: located.message,
          raw: line,
          file: located.file ?? currentFile,
          line: located.line,
          column: located.column,
          latexPass: isLatexPhase(phase) ? latexPass : undefined
        });
        pendingBang = undefined;
        continue;
      }
    }

    const packageDiagnostic = parsePackageLine(line);
    if (packageDiagnostic) {
      addDiagnostic(diagnostics, {
        ...packageDiagnostic,
        phase,
        raw: line,
        file: currentFile,
        line: lineFromMessage(packageDiagnostic.message),
        latexPass: isLatexPhase(phase) ? latexPass : undefined
      });
      pendingBang = undefined;
      continue;
    }

    const latexDiagnostic = parseLatexLine(line);
    if (latexDiagnostic) {
      addDiagnostic(diagnostics, {
        ...latexDiagnostic,
        phase: phase === "unknown" ? "pdflatex" : phase,
        raw: line,
        file: currentFile,
        line: lineFromMessage(latexDiagnostic.message),
        latexPass: isLatexPhase(phase) ? latexPass : undefined
      });
      pendingBang = undefined;
      continue;
    }

    if (/^!\s+/.test(line)) {
      pendingBang = addDiagnostic(diagnostics, {
        severity: "error",
        phase: phase === "unknown" ? "pdflatex" : phase,
        message: line.slice(2).trim(),
        raw: line,
        file: currentFile,
        latexPass: isLatexPhase(phase) ? latexPass : undefined
      });
      continue;
    }

    const texLocation = line.match(latexLinePattern);
    if (texLocation && pendingBang) {
      pendingBang.line = Number(texLocation.groups?.line);
      pendingBang.key = diagnosticKey(pendingBang);
      continue;
    }

    const warning = parseGenericWarning(line);
    if (warning) {
      addDiagnostic(diagnostics, {
        ...warning,
        phase,
        raw: line,
        file: currentFile,
        line: lineFromMessage(warning.message),
        latexPass: isLatexPhase(phase) ? latexPass : undefined
      });
      pendingBang = undefined;
      continue;
    }

    if (isLatexmkFailure(line)) {
      addDiagnostic(diagnostics, {
        severity: "error",
        phase: "latexmk",
        message: line.replace(/^Latexmk:\s*/i, "").trim(),
        raw: line
      });
      pendingBang = undefined;
    }
  }

  const unique = dedupeDiagnostics(diagnostics);
  // A successful process/PDF is the source of truth.  Do not report a stale
  // BibTeX error from an earlier pass as a compile error after latexmk has
  // completed successfully.
  const errors = resolvedOutcome === "succeeded" ? [] : unique.filter((item) => item.severity === "error");
  const warnings = unique.filter((item) => item.severity === "warning")
    .filter((item) => lastLatexPass < 2 || !isLatexPhase(item.phase) || item.latexPass === lastLatexPass);
  if (resolvedOutcome === "failed" && errors.length === 0) {
    const fallback: MutableDiagnostic = {
      severity: "error",
      phase: "system",
      message: "Compilation failed without a parsed diagnostic; inspect the raw log.",
      raw: "",
      key: "system-failure"
    };
    errors.push(fallback);
  }
  return { warnings: publicDiagnostics(warnings), errors: publicDiagnostics(errors) };
}

function hasSuccessfulLatexmkResult(log: string): boolean {
  return /Latexmk: All targets .* are up-to-date/i.test(log)
    && /Output written on .*\.pdf/i.test(log);
}

function parseLocatedLine(line: string): {
  file?: string;
  line?: number;
  column?: number;
  severity?: CompileDiagnosticSeverity;
  message: string;
} | null {
  const match = line.match(locationPattern);
  if (!match?.groups) return null;
  const rest = match.groups.rest;
  const marker = rest.match(/\b(?:LaTeX(?:\s+[^:]+)?|Package|Class|pdfTeX|XeTeX|LuaTeX)\s+(?<severity>Error|Warning):\s*(?<message>.*)$/i);
  if (!marker?.groups) return { file: match.groups.file, line: Number(match.groups.line), column: match.groups.column ? Number(match.groups.column) : undefined, message: rest };
  return {
    file: match.groups.file.replaceAll("\\", "/"),
    line: Number(match.groups.line),
    column: match.groups.column ? Number(match.groups.column) : undefined,
    severity: marker.groups.severity.toLowerCase() as CompileDiagnosticSeverity,
    message: marker.groups.message.trim()
  };
}

function parsePackageLine(line: string): { severity: CompileDiagnosticSeverity; message: string } | null {
  const match = line.match(/^(?:Package|Class)\s+[^:]+\s+(?<severity>Error|Warning):\s*(?<message>.*)$/i);
  if (!match?.groups) return null;
  return { severity: match.groups.severity.toLowerCase() as CompileDiagnosticSeverity, message: match.groups.message.trim() };
}

function parseLatexLine(line: string): { severity: CompileDiagnosticSeverity; message: string } | null {
  const match = line.match(/^(?:LaTeX(?:\s+[^:]+)?|pdfTeX|XeTeX|LuaTeX)\s+(?<severity>Error|Warning):\s*(?<message>.*)$/i);
  if (!match?.groups) return null;
  return { severity: match.groups.severity.toLowerCase() as CompileDiagnosticSeverity, message: match.groups.message.trim() };
}

function parseGenericWarning(line: string): { severity: "warning"; message: string } | null {
  if (/^(?:Overfull|Underfull)\b/i.test(line) || /^(?:pdfTeX|XeTeX|LuaTeX)\s+warning\b/i.test(line)) {
    return { severity: "warning", message: line };
  }
  return null;
}

function lineFromMessage(message: string): number | undefined {
  const match = message.match(inputLinePattern);
  return match?.groups?.line ? Number(match.groups.line) : undefined;
}

function isLatexmkFailure(line: string): boolean {
  return /^Latexmk:.*(?:\bErrors?,|did not complete making targets|failure)/i.test(line)
    || /^Collected error summary/i.test(line)
    || /^error, and then rerun latexmk/i.test(line)
    || /\b(?:fatal error|emergency stop|no output pdf|no pages of output)\b/i.test(line)
    || /\b(?:bibtex|biber) errors?:/i.test(line);
}

function addDiagnostic(target: MutableDiagnostic[], input: Omit<CompileDiagnostic, "raw"> & { raw: string; latexPass?: number }): MutableDiagnostic {
  const diagnostic: MutableDiagnostic = { ...input, key: diagnosticKey(input) };
  const existing = target.find((item) => item.key === diagnostic.key
    || (item.severity === diagnostic.severity && item.phase === diagnostic.phase
      && item.message === diagnostic.message && item.file === diagnostic.file
      && (item.line === undefined || diagnostic.line === undefined)));
  if (existing) {
    if (existing.line === undefined && diagnostic.line !== undefined) existing.line = diagnostic.line;
    if (!existing.file && diagnostic.file) existing.file = diagnostic.file;
    existing.key = diagnosticKey(existing);
    return existing;
  }
  target.push(diagnostic);
  return diagnostic;
}

function diagnosticKey(item: Omit<CompileDiagnostic, "raw">): string {
  return [item.severity, item.phase, item.file ?? "", item.line ?? "", item.column ?? "", item.message].join("\u0000");
}

function dedupeDiagnostics(items: MutableDiagnostic[]): MutableDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = diagnosticKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicDiagnostics(items: MutableDiagnostic[]): CompileDiagnostic[] {
  return items.map(({ key: _key, latexPass: _latexPass, ...item }) => item);
}

function isLatexPhase(phase: CompileDiagnosticPhase): boolean {
  return phase === "pdflatex" || phase === "xelatex" || phase === "lualatex";
}
