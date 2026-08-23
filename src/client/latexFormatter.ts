const latexSourcePattern = /\.(?:tex|bib|cls|sty)$/i;

type TexFmtModule = typeof import("./texFmtRuntime");

let texFmtModule: Promise<TexFmtModule> | null = null;

/**
 * Format LaTeX source in the browser with the bundled tex-fmt WASM build.
 *
 * The module is loaded lazily so opening a project does not pay for the
 * formatter unless the user formats a file (or enables format-before-compile).
 * `config` is the TOML options string accepted by tex-fmt and is deliberately
 * supplied by the caller so editor preferences can remain user/project local.
 */
export async function formatWithTexFmt(source: string, config = ""): Promise<string> {
  texFmtModule ??= import("./texFmtRuntime");
  let main: TexFmtModule["main"];
  try {
    ({ main } = await texFmtModule);
  } catch {
    // Do not permanently cache a transient asset/CSP failure. A later
    // attempt can succeed after the browser has recovered its connection.
    texFmtModule = null;
    throw new Error("The bundled tex-fmt formatter could not be loaded.");
  }
  let result: unknown;
  try {
    result = main(source, config);
  } catch {
    throw new Error("tex-fmt could not format this source. Check the TOML formatter options.");
  }
  if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") {
    throw new Error("tex-fmt returned an invalid formatting result.");
  }
  return result.output;
}

export interface LatexTextEdit {
  from: number;
  to: number;
  replacement: string;
}

export function isFormattableLatexFile(filePath: string): boolean {
  return latexSourcePattern.test(filePath);
}

function trailingLineBreaks(source: string): string {
  return source.match(/(?:\r?\n)+$/)?.[0] ?? "";
}

/**
 * Put formatted selection text back at the indentation level from which it
 * was selected. Formatters generally format from column zero, while a
 * selection inside an environment should remain nested in the document.
 */
export function reindentLatexSelection(source: string, formatted: string): string {
  const trailing = trailingLineBreaks(source);
  const body = trailing ? source.slice(0, -trailing.length) : source;
  const lines = body.split(/\r?\n/);
  const firstContentLine = lines.find((line) => line.trim());
  const baseIndent = firstContentLine?.match(/^[\t ]*/)?.[0] ?? "";
  const normalized = formatted.replace(/(?:\r?\n)+$/, "");
  const reindented = baseIndent
    ? normalized.split("\n").map((line) => line ? `${baseIndent}${line}` : line).join("\n")
    : normalized;
  return `${reindented}${trailing}`;
}

export async function createLatexTextEdits(source: string, formatted: string, baseOffset = 0): Promise<LatexTextEdit[]> {
  if (source === formatted) return [];
  const { default: DiffMatchPatch } = await import("diff-match-patch");
  const engine = new DiffMatchPatch();
  const diffs = engine.diff_main(source, formatted, true);
  engine.diff_cleanupEfficiency(diffs);
  const edits: LatexTextEdit[] = [];
  let sourceOffset = baseOffset;
  let pending: LatexTextEdit | null = null;
  const flush = () => {
    if (pending) edits.push(pending);
    pending = null;
  };
  for (const [kind, text] of diffs) {
    if (kind === DiffMatchPatch.DIFF_EQUAL) {
      flush();
      sourceOffset += text.length;
    } else if (kind === DiffMatchPatch.DIFF_DELETE) {
      pending ??= { from: sourceOffset, to: sourceOffset, replacement: "" };
      pending.to += text.length;
      sourceOffset += text.length;
    } else {
      pending ??= { from: sourceOffset, to: sourceOffset, replacement: "" };
      pending.replacement += text;
    }
  }
  flush();
  return edits;
}
