import type { Lint, Linter, Suggestion } from "harper.js";
import { LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";

export interface RawHarperLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  message: string;
  suggestions: string[];
}

function suggestionText(suggestion: Suggestion): string {
  return suggestion.get_replacement_text();
}

export async function createHarperLinter(): Promise<Linter> {
  const linter = new LocalLinter({ binary });
  await linter.setup();
  return linter;
}

export async function collectHarperLints(linter: Linter, source: string): Promise<RawHarperLint[]> {
  const lints = await linter.lint(source, { language: "plaintext", dedup: true, isolateEnglish: false });
  try {
    return lints.map((lint: Lint) => {
      const span = lint.span();
      const suggestions = lint.suggestions();
      try {
        return {
          start: span.start,
          end: span.end,
          problem: lint.get_problem_text(),
          kind: lint.lint_kind(),
          message: lint.message(),
          suggestions: suggestions.map(suggestionText)
        };
      } finally {
        span.free();
        for (const suggestion of suggestions) suggestion.free();
      }
    });
  } finally {
    for (const lint of lints) lint.free();
  }
}
