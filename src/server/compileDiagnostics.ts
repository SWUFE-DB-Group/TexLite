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

const toolPattern = /^(pdflatex|xelatex|lualatex|bibtex|biber)(?=\s|$)/i;
const commandPattern = /\b(pdflatex|xelatex|lualatex|bibtex|biber)\b/i;
const rulePassPattern = /^Run number \d+ of rule ['"]([^'"]+)['"]$/i;
const engineBanner = /^This is (pdfTeX|XeTeX|Lua(?:HB)?TeX)\b/i;
const locationPattern = /^(?<file>(?:[A-Za-z]:[\\/])?[^:\r\n]+):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<rest>.*)$/;
const inputLinePattern = /\bon input line (?<line>\d+)\b/i;
const latexLinePattern = /^l\.(?<line>\d+)\b/;

export function parseCompileDiagnostics(log: string, outcome: CompileDiagnosticOutcome = null, mainFile?: string): CompileDiagnostics {
  const lines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const resolvedOutcome: CompileDiagnosticOutcome = outcome ?? (hasSuccessfulLatexmkResult(log) ? "succeeded" : null);
  const diagnostics: MutableDiagnostic[] = [];
  let activePhase: CompileDiagnosticPhase = "unknown";
  let currentFile = mainFile;
  let pendingBang: MutableDiagnostic | undefined;
  let latexPass = 0;
  let hasRulePass = false;
  let hasEngineBanner = false;
  const beginPass = (phase: CompileDiagnosticPhase) => {
    activePhase = phase;
    if (isLatexPhase(phase)) ++latexPass;
    hasEngineBanner = false;
    currentFile = mainFile;
    pendingBang = undefined;
  };

  for (const line of lines) {
    const rule = line.match(rulePassPattern)?.[1];
    if (rule) {
      const tool = rule.match(toolPattern)?.[1];
      beginPass(tool ? tool.toLowerCase() as CompileDiagnosticPhase : "unknown");
      hasRulePass = true;
      continue;
    }
    const command = line.match(commandPattern);
    if (/^Running\s+['"]/i.test(line) && (command || hasRulePass)) {
      if (!hasRulePass && command) beginPass(command[1].toLowerCase() as CompileDiagnosticPhase);
      hasRulePass = false;
      const texArgument = [...line.matchAll(/(?:['"]|\s)([^\s'"]+\.tex)(?:['"]|\s|$)/gi)].at(-1)?.[1];
      if (texArgument) currentFile = texArgument.replaceAll("\\", "/");
      pendingBang = undefined;
      continue;
    }
    const banner = line.match(engineBanner)?.[1]?.toLowerCase();
    if (banner) {
      if (hasEngineBanner || !isLatexPhase(activePhase)) {
        beginPass(banner === "pdftex" ? "pdflatex" : banner === "xetex" ? "xelatex" : "lualatex");
      }
      hasEngineBanner = true;
      hasRulePass = false;
    }
    // stdout and stderr can interleave; latexmk's own messages do not end a TeX pass.
    const phase = /^Latexmk:/i.test(line) ? "latexmk" : activePhase;

    const located = parseLocatedLine(line);
    if (located) {
      currentFile = located.file;
      // With -file-line-error, TeX errors such as "Undefined control sequence."
      // have a location but no Error: prefix. Infer severity only on a failed pass.
      const severity = located.severity ?? (
        resolvedOutcome === "failed" && isLatexPhase(phase) && /\.[a-z0-9]+$/i.test(located.file) && located.message
          ? "error" : undefined
      );
      if (severity) {
        addDiagnostic(diagnostics, {
          severity,
          phase,
          message: located.message,
          raw: line,
          file: located.file,
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

  // A successful process/PDF is the source of truth.  Do not report a stale
  // BibTeX error from an earlier pass as a compile error after latexmk has
  // completed successfully.
  const errors = resolvedOutcome === "succeeded" ? [] : dedupeDiagnostics(diagnostics.filter((item) => item.severity === "error"));
  const warnings = dedupeDiagnostics(diagnostics.filter((item) => item.severity === "warning"
    && (item.latexPass === undefined || item.latexPass === latexPass)));
  const hasUndefinedDetail = warnings.some((item) => /^(?:Citation|Reference)\b.*\bundefined\b/i.test(item.message));
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
  return {
    warnings: publicDiagnostics(hasUndefinedDetail ? warnings.filter((item) => !/^There were undefined (?:references|citations)\.?$/i.test(item.message)) : warnings),
    errors: publicDiagnostics(errors)
  };
}

function hasSuccessfulLatexmkResult(log: string): boolean {
  return /Latexmk: All targets .* are up-to-date/i.test(log)
    && /Output written on .*\.pdf/i.test(log);
}

function parseLocatedLine(line: string): {
  file: string;
  line: number;
  column?: number;
  severity?: CompileDiagnosticSeverity;
  message: string;
} | null {
  const match = line.match(locationPattern);
  if (!match?.groups) return null;
  const rest = match.groups.rest;
  const marker = rest.match(/^(?<severity>Error|Warning):\s*(?<message>.*)$/i)?.groups
    ?? rest.match(/\b(?:LaTeX(?:\s+[^:]+)?|Package|Class|pdfTeX|XeTeX|LuaTeX)\s+(?<severity>Error|Warning):\s*(?<message>.*)$/i)?.groups;
  const diagnostic = marker
    ? { severity: marker.severity.toLowerCase() as CompileDiagnosticSeverity, message: marker.message.trim() }
    : parseGenericWarning(rest) ?? { message: rest };
  return {
    file: match.groups.file.replaceAll("\\", "/"),
    line: Number(match.groups.line),
    column: match.groups.column ? Number(match.groups.column) : undefined,
    ...diagnostic
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
  const existing = target.find((item) => (item.severity !== "warning" || item.latexPass === diagnostic.latexPass) && (item.key === diagnostic.key
    || (item.severity === diagnostic.severity && item.phase === diagnostic.phase
      && item.message === diagnostic.message && item.file === diagnostic.file
      && (item.line === undefined || diagnostic.line === undefined))));
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
