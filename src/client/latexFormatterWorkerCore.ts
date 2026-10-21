import { main } from "tex-fmt";
import type { TexFmtFailureKind, TexFmtResult } from "./latexFormatterProtocol";

export class LatexFormatterWorkerError extends Error {
  constructor(public readonly kind: TexFmtFailureKind, message: string) {
    super(message);
    this.name = "LatexFormatterWorkerError";
  }
}

export function formatTexSource(source: string, config: string): TexFmtResult {
  let result: unknown;
  try {
    result = main(source, config);
  } catch {
    throw new LatexFormatterWorkerError("format", "tex-fmt could not format this source. Check the TOML formatter options.");
  }
  if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") {
    throw new LatexFormatterWorkerError("result", "tex-fmt returned an invalid formatting result.");
  }
  const logs = "logs" in result && typeof result.logs === "string" ? result.logs : "";
  return { output: result.output, logs };
}
