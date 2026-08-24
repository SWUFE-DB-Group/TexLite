import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export interface PdfSyncLocation {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceSyncLocation {
  input: string;
  line: number;
  column: number;
}

/** A user-correctable SyncTeX failure, rather than an opaque server error. */
export class SyncTeXError extends Error {
  readonly statusCode = 422;
  readonly code = "SYNCTEX_FAILED";

  constructor() {
    super("SYNCTEX_FAILED");
    this.name = "SyncTeXError";
  }
}

async function runSynctex(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await runFile("synctex", args, {
      cwd, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8"
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr) : "";
    // The raw SyncTeX stderr is retained in neither API responses nor logs:
    // it can contain absolute project paths and is not actionable to writers.
    void stderr;
    throw new SyncTeXError();
  }
}

export async function sourceToPdf(
  sourceDirectory: string,
  pdfPath: string,
  sourcePath: string,
  line: number,
  column: number
): Promise<PdfSyncLocation | null> {
  const output = await runSynctex([
    "view", "-i", `${line}:${column}:${sourcePath}`, "-o", pdfPath
  ], sourceDirectory);
  const page = numericField(output, "Page");
  const x = numericField(output, "x");
  const y = numericField(output, "y");
  // Comments, blank lines, and parts of the preamble may not have a
  // typeset position. SyncTeX exits successfully but returns no result for
  // those locations; that is a normal "nothing to jump to" outcome, not a
  // malformed request.
  if (!page || x === null || y === null) return null;
  return {
    page,
    x,
    y,
    width: numericField(output, "W") ?? 0,
    height: numericField(output, "H") ?? 0
  };
}

export async function pdfToSource(
  sourceDirectory: string,
  pdfPath: string,
  page: number,
  x: number,
  y: number
): Promise<SourceSyncLocation> {
  const output = await runSynctex([
    "edit", "-o", `${page}:${x}:${y}:${pdfPath}`
  ], sourceDirectory);
  const input = textField(output, "Input");
  const line = numericField(output, "Line");
  const column = numericField(output, "Column");
  if (!input || !line) throw new SyncTeXError();
  const absoluteInput = path.isAbsolute(input) ? input : path.resolve(sourceDirectory, input);
  return { input: absoluteInput, line, column: column && column > 0 ? column : 1 };
}

function numericField(output: string, name: string): number | null {
  const match = output.match(new RegExp(`^${name}:([-+]?\\d+(?:\\.\\d+)?)$`, "m"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function textField(output: string, name: string): string | null {
  return output.match(new RegExp(`^${name}:(.+)$`, "m"))?.[1]?.trim() || null;
}
