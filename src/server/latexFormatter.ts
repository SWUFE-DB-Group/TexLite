import { spawn } from "node:child_process";

export type LatexFormatterName = "tex-fmt";

export interface LatexFormatResult {
  formatter: LatexFormatterName;
  formatted: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
}

const DEFAULT_COMMAND = "tex-fmt";
const FORMAT_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

/**
 * Invokes the optional host formatter without involving a shell.  Keeping
 * this in the server means project-level tex-fmt.toml files are discovered
 * from the project's source directory and the browser never needs a native
 * executable.
 */
export class LatexFormatterService {
  private readonly command: string;

  constructor(command = process.env.TEXLITE_TEX_FMT?.trim() || DEFAULT_COMMAND) {
    this.command = command;
  }

  async format(source: string, cwd: string): Promise<LatexFormatResult> {
    const result = await runCommand(this.command, ["--stdin"], source, cwd, FORMAT_TIMEOUT_MS);
    // tex-fmt is optional like Git, but formatting must never silently switch
    // algorithms: users should know when the host formatter is unavailable.
    if (result.error?.code === "ENOENT") throw formatterUnavailable(this.command);
    if (result.error) throw formatterError(`无法运行 tex-fmt：${result.error.message}`);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `退出码 ${result.status ?? "unknown"}`;
      throw formatterError(`tex-fmt 格式化失败：${truncate(detail)}`);
    }
    if (source.trim() && !result.stdout.trim()) throw formatterError("tex-fmt 未返回格式化后的源码");
    return { formatter: "tex-fmt", formatted: result.stdout };
  }
}

function formatterError(message: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code: "FORMAT_FAILED", statusCode: 422 });
}

function formatterUnavailable(command: string): Error & { code: string; statusCode: number } {
  return Object.assign(
    new Error(`tex-fmt is not installed or cannot be found as "${command}". Install it from https://github.com/wgunderwood/tex-fmt and restart TexLite.`),
    { code: "FORMATTER_UNAVAILABLE", statusCode: 503 }
  );
}

function truncate(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_DIAGNOSTIC_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")}…`;
}

function runCommand(command: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, LC_ALL: "C" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? Object.assign(error, { code: (error as NodeJS.ErrnoException).code }) : new Error(String(error))
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    const finish = (result: Omit<RunResult, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputTooLarge || stdoutBytes >= 64 * 1024 * 1024) return;
      const remaining = 64 * 1024 * 1024 - stdoutBytes;
      const bytes = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout.push(bytes);
      stdoutBytes += bytes.byteLength;
      if (chunk.byteLength > remaining) {
        outputTooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      const remaining = MAX_DIAGNOSTIC_BYTES - stderrBytes;
      const bytes = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(bytes);
      stderrBytes += bytes.byteLength;
    });
    child.once("error", (error: NodeJS.ErrnoException) => finish({ status: null, error }));
    child.once("close", (status) => {
      finish({
        status,
        error: timedOut ? new Error(`命令超时（${timeoutMs}ms）`) : outputTooLarge ? new Error("tex-fmt 输出过大") : null
      });
    });
    child.stdin.end(input, "utf8");
  });
}
