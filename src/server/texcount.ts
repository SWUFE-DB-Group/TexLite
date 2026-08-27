import { spawn, type ChildProcess } from "node:child_process";
import { detachedProcessGroup, killProcessGroup } from "./processTree.js";

/** TeXcount is an optional host command supplied by TeX Live. */
export const TEXCOUNT_COMMAND = "texcount";
const TEXLITE_WORD_REPORT_PREFIX = "__TEXLITE_TEXCOUNT_WORDS__";
const TEXLITE_CHARACTER_REPORT_PREFIX = "__TEXLITE_TEXCOUNT_CHARS__";
// TeXcount placeholders {1} through {7} are, respectively: words in text,
// header words, caption words, header count, float count, inline math, and
// displayed math.  Do not parse TeXcount's human-facing prose report.
const TEXLITE_WORD_REPORT_TEMPLATE = `${TEXLITE_WORD_REPORT_PREFIX}|{1}|{2}|{3}|{4}|{5}|{6}|{7}`;
const TEXLITE_CHARACTER_REPORT_TEMPLATE = `${TEXLITE_CHARACTER_REPORT_PREFIX}|{1}|{2}|{3}|{4}|{5}|{6}|{7}`;

const PROBE_TIMEOUT_MS = 5_000;
const COUNT_TIMEOUT_MS = 30_000;
const UNAVAILABLE_RETRY_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface TexcountCounts {
  textWords: number;
  headerWords: number;
  captionWords: number;
  totalWords: number;
  headers: number;
  floats: number;
  inlineMath: number;
  displayMath: number;
  totalCharacters: number;
  files: number | null;
  parserErrors: number;
}

type WordTexcountCounts = Omit<TexcountCounts, "totalCharacters">;

interface ParsedTexcountReport {
  text: number;
  headers: number;
  captions: number;
  headerCount: number;
  floatCount: number;
  inlineMathCount: number;
  displayMathCount: number;
  parserErrors: number;
}

export class TexcountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TexcountUnavailableError";
  }
}

export class TexcountExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TexcountExecutionError";
  }
}

/**
 * Run the optional host TeXcount binary and normalize its explicit report
 * template into stable fields for the browser. The command is intentionally
 * fixed (rather than shell-evaluated) so project sources cannot inject flags.
 */
export class TexcountService {
  private availability: "unknown" | "available" | "unavailable" = "unknown";
  private lastUnavailableAt = 0;
  private probePromise: Promise<void> | null = null;
  private activeChildren = new Set<ChildProcess>();
  private disposed = false;

  constructor(private readonly command = TEXCOUNT_COMMAND) {}

  async countFile(cwd: string, filePath: string): Promise<TexcountCounts> {
    await this.ensureAvailable();
    return this.count(cwd, ["-inc", "-total"], filePath);
  }

  async countSource(cwd: string, source: string): Promise<TexcountCounts> {
    await this.ensureAvailable();
    // A dash tells TeXcount to read one virtual TeX document from stdin. No
    // include traversal is requested for a selection because the selection
    // is not a complete project tree.
    return this.count(cwd, ["-total"], "-", source);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const child of this.activeChildren) killProcessGroup(child, "SIGTERM");
    this.activeChildren.clear();
    await this.probePromise?.catch(() => undefined);
    this.probePromise = null;
  }

  private async ensureAvailable(): Promise<void> {
    if (this.disposed) throw new TexcountUnavailableError("TeXcount service stopped.");
    if (this.availability === "available") return;
    if (this.availability === "unavailable" && Date.now() - this.lastUnavailableAt < UNAVAILABLE_RETRY_MS) {
      throw new TexcountUnavailableError(`The optional ${this.command} command is not available.`);
    }
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.runCommand(["--version"], undefined, undefined, PROBE_TIMEOUT_MS, 64 * 1024)
      .then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error((stderr || stdout).trim() || `exited with code ${code}`);
        this.availability = "available";
      })
      .catch((error) => {
        this.availability = "unavailable";
        this.lastUnavailableAt = Date.now();
        const detail = error instanceof Error ? error.message : String(error);
        throw new TexcountUnavailableError(`The optional ${this.command} command is unavailable: ${detail}`);
      })
      .finally(() => { this.probePromise = null; });
    return this.probePromise;
  }

  private async count(cwd: string, options: string[], target: string, input?: string): Promise<TexcountCounts> {
    const [wordResult, characterResult] = await Promise.all([
      this.runCommand([...options, `-template=${TEXLITE_WORD_REPORT_TEMPLATE}`, target], cwd, input),
      this.runCommand([...options, "-char", `-template=${TEXLITE_CHARACTER_REPORT_TEMPLATE}`, target], cwd, input)
    ]);
    const words = this.finishWordCount(wordResult);
    const characters = this.finishCharacterCount(characterResult);
    return {
      ...words,
      totalCharacters: characters.text + characters.headers + characters.captions,
      // TeXcount parses the same source twice. Do not show each syntax issue
      // twice merely because character counting was requested as well.
      parserErrors: Math.max(words.parserErrors, characters.parserErrors)
    };
  }

  private finishWordCount(result: CommandResult): WordTexcountCounts {
    if (result.code !== 0) {
      throw new TexcountExecutionError(result.stderr.trim() || `${this.command} exited with code ${result.code}`);
    }
    try {
      return parseTexcountOutput(result.stdout);
    } catch (error) {
      throw new TexcountExecutionError(error instanceof Error ? error.message : String(error));
    }
  }

  private finishCharacterCount(result: CommandResult): ParsedTexcountReport {
    if (result.code !== 0) {
      throw new TexcountExecutionError(result.stderr.trim() || `${this.command} exited with code ${result.code}`);
    }
    try {
      return parseTexcountReport(result.stdout, TEXLITE_CHARACTER_REPORT_PREFIX);
    } catch (error) {
      throw new TexcountExecutionError(error instanceof Error ? error.message : String(error));
    }
  }

  private runCommand(
    args: string[], cwd?: string, input?: string, timeoutMs = COUNT_TIMEOUT_MS, outputLimit = MAX_OUTPUT_BYTES
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new TexcountUnavailableError("TeXcount service stopped."));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(this.command, args, {
          cwd,
          env: { ...process.env, LC_ALL: "C" },
          shell: false,
          detached: detachedProcessGroup(),
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.activeChildren.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputTooLarge = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        callback();
      };
      const terminateWithError = (error: Error): void => {
        killProcessGroup(child);
        finish(() => reject(error));
      };
      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) {
          outputTooLarge = true;
          terminateWithError(new TexcountExecutionError(`${this.command} produced too much output.`));
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      child.stdin?.on("error", (error) => terminateWithError(error));
      child.once("error", (error) => finish(() => {
        if (timedOut) {
          reject(new TexcountExecutionError(`${this.command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new TexcountUnavailableError(`The optional ${this.command} command is not available.`));
          return;
        }
        reject(error);
      }));
      child.once("close", (code) => finish(() => {
        if (timedOut) {
          reject(new TexcountExecutionError(`${this.command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
          return;
        }
        if (outputTooLarge) {
          reject(new TexcountExecutionError(`${this.command} produced too much output.`));
          return;
        }
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      }));
      if (input !== undefined) child.stdin?.end(input, "utf8");
    });
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Parse TexLite's explicit TeXcount template, rather than prose output. */
export function parseTexcountOutput(output: string): WordTexcountCounts {
  const report = parseTexcountReport(output, TEXLITE_WORD_REPORT_PREFIX);
  const filesMatch = /Files:\s*(\d+)/i.exec(output);
  return {
    textWords: report.text,
    headerWords: report.headers,
    captionWords: report.captions,
    totalWords: report.text + report.headers + report.captions,
    headers: report.headerCount,
    floats: report.floatCount,
    inlineMath: report.inlineMathCount,
    displayMath: report.displayMathCount,
    files: filesMatch ? Number(filesMatch[1]) : null,
    parserErrors: report.parserErrors
  };
}

function parseTexcountReport(output: string, prefix: string): ParsedTexcountReport {
  const report = new RegExp(`${prefix}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`).exec(output);
  if (!report) {
    throw new Error("TeXcount did not return TexLite's expected report; a %TC:newtemplate or %TC:template directive may have overridden it.");
  }
  const [, text, header, caption, headerCount, floatCount, inlineMathCount, displayMathCount] = report;
  const errorsMatch = /\(errors:\s*(\d+)\)/i.exec(output);
  return {
    text: Number(text),
    headers: Number(header),
    captions: Number(caption),
    headerCount: Number(headerCount),
    floatCount: Number(floatCount),
    inlineMathCount: Number(inlineMathCount),
    displayMathCount: Number(displayMathCount),
    parserErrors: errorsMatch ? Number(errorsMatch[1]) : 0
  };
}
