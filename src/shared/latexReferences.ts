/**
 * Source-level LaTeX reference scanning. Lexical mechanics, dependency
 * extraction, command classification, and BibTeX key scanning live in their
 * own focused modules; this file only assembles them into editor-facing
 * references and definition targets.
 */

import { findBibtexEntryKeys } from "./bibtexReferences.js";
import { maskLatexComments } from "./latexLiterals.js";
import {
  forEachLatexCommand,
  isLatexCommentStart,
  readLatexBalancedArgument,
  readLatexMandatoryArguments,
  readLatexOptionalArguments,
  skipLatexComment,
  skipLatexTrivia,
  type LatexArgumentSpan
} from "./latexScanner.js";
import {
  classifyLatexReferenceCommand,
  type LatexReferenceCommandSpec,
  type LatexReferenceKind
} from "./latexReferenceCommands.js";

export type { LatexReferenceKind } from "./latexReferenceCommands.js";
export { findLatexBibliographyFiles, findLatexSourceIncludes } from "./latexDependencies.js";
export type { LatexPathReference } from "./latexDependencies.js";
export { maskLatexComments } from "./latexLiterals.js";

export interface LatexReference {
  kind: LatexReferenceKind;
  command: string;
  key: string;
  from: number;
  to: number;
}

export interface LatexReferenceDefinition {
  key: string;
  command: string;
  targetFrom: number;
  targetTo: number;
  source: "label" | "bibitem" | "bibtex";
}

function keyRanges(source: string, argument: LatexArgumentSpan): Array<{ key: string; from: number; to: number }> {
  const ranges: Array<{ key: string; from: number; to: number }> = [];
  // Preserve source offsets while treating comments as whitespace. In
  // particular, a comment after a comma must not become part of the next key.
  const masked = maskLatexComments(source.slice(argument.contentFrom, argument.contentTo));
  let segmentStart = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    if (index !== masked.length && masked[index] !== ",") continue;
    let from = segmentStart;
    let to = index;
    while (from < to && /\s/.test(masked[from])) from += 1;
    while (to > from && /\s/.test(masked[to - 1])) to -= 1;
    if (to > from) {
      const absoluteFrom = argument.contentFrom + from;
      const absoluteTo = argument.contentFrom + to;
      ranges.push({ key: source.slice(absoluteFrom, absoluteTo), from: absoluteFrom, to: absoluteTo });
    }
    segmentStart = index + 1;
  }
  return ranges;
}

/**
 * Return the unclosed key argument for a known command shape. Mandatory
 * arguments may be preceded by completed optional arguments; `\\hyperref`
 * is the notable optional-key form.
 */
function unfinishedReferenceArgument(source: string, start: number, spec: LatexReferenceCommandSpec): number | null {
  let index = start;
  for (let count = 0; count < spec.maximumArguments; count += 1) {
    index = skipLatexTrivia(source, index);
    if (spec.argumentKind === "optional") {
      if (source[index] !== "[") return null;
      const optional = readLatexBalancedArgument(source, index, "[", "]");
      if (!optional) return index + 1;
      index = optional.to;
      continue;
    }

    while (source[index] === "[") {
      const optional = readLatexBalancedArgument(source, index, "[", "]");
      if (!optional) return null;
      index = skipLatexTrivia(source, optional.to);
    }
    if (source[index] !== "{") return null;
    const mandatory = readLatexBalancedArgument(source, index, "{", "}");
    if (!mandatory) return index + 1;
    index = mandatory.to;
  }
  return null;
}

function currentReferenceKey(source: string, start: number): { from: number; query: string } {
  let itemStart = start;
  for (let index = start; index < source.length; index += 1) {
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index) - 1;
      continue;
    }
    if (source[index] === ",") itemStart = index + 1;
  }
  const from = skipLatexTrivia(source, itemStart);
  return { from, query: source.slice(from) };
}

function findLatexReferenceCompletion(
  source: string,
  kind: LatexReferenceKind
): { from: number; query: string } | null {
  let argumentStart: number | null = null;
  forEachLatexCommand(source, (command) => {
    const spec = classifyLatexReferenceCommand(command.name);
    if (!spec || spec.kind !== kind) return;
    const active = unfinishedReferenceArgument(source, command.to, spec);
    if (active !== null) argumentStart = active;
  });
  return argumentStart === null ? null : currentReferenceKey(source, argumentStart);
}

/**
 * Return the active key range while a citation command is still being
 * written. This shares navigation's command classification and lexical rules.
 */
export function findLatexCitationCompletion(source: string): { from: number; query: string } | null {
  return findLatexReferenceCompletion(source, "citation");
}

/**
 * Return the active label range while a cross-reference command is being
 * written, including both arguments of `\\crefrange`.
 */
export function findLatexLabelCompletion(source: string): { from: number; query: string } | null {
  return findLatexReferenceCompletion(source, "label");
}

/**
 * Return individual keys inside visible citation and cross-reference commands.
 * Nested commands remain visible, for example a citation in a caption option.
 */
export function findLatexReferences(source: string): LatexReference[] {
  const references: LatexReference[] = [];
  forEachLatexCommand(source, (command) => {
    const spec = classifyLatexReferenceCommand(command.name);
    if (!spec) return;
    const argumentsFound = spec.argumentKind === "optional"
      ? readLatexOptionalArguments(source, command.to, spec.maximumArguments)
      : readLatexMandatoryArguments(source, command.to, spec.maximumArguments);
    for (const argument of argumentsFound) {
      for (const range of keyRanges(source, argument)) {
        references.push({ kind: spec.kind, command: command.name, ...range });
      }
    }
  });
  return references.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function latexReferenceAt(source: string, offset: number): LatexReference | null {
  return findLatexReferences(source).find((reference) => offset >= reference.from && offset < reference.to) ?? null;
}

function definitionsFromLatex(source: string, kind: LatexReferenceKind): LatexReferenceDefinition[] {
  const definitions: LatexReferenceDefinition[] = [];
  forEachLatexCommand(source, (command) => {
    if (kind === "label" && (command.name === "label" || command.name === "hypertarget")) {
      const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const range of keyRanges(source, argument)) {
        definitions.push({
          key: range.key,
          command: command.name,
          targetFrom: command.from,
          targetTo: argument.to,
          source: "label"
        });
      }
      return;
    }
    if (kind === "citation" && command.name === "bibitem") {
      const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const range of keyRanges(source, argument)) {
        definitions.push({
          key: range.key,
          command: command.name,
          targetFrom: command.from,
          targetTo: argument.to,
          source: "bibitem"
        });
      }
    }
  });
  return definitions;
}

function definitionsFromBibtex(source: string): LatexReferenceDefinition[] {
  return findBibtexEntryKeys(source).map((entry) => ({
    key: entry.key,
    command: "bibtex",
    targetFrom: entry.entryFrom,
    targetTo: entry.entryTo,
    source: "bibtex"
  }));
}

export function findLatexReferenceDefinitions(
  source: string,
  kind: LatexReferenceKind,
  bibtex = false
): LatexReferenceDefinition[] {
  if (bibtex) return kind === "citation" ? definitionsFromBibtex(source) : [];
  return definitionsFromLatex(source, kind);
}

export function lineAndColumnAt(source: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (source[index] !== "\n") continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: boundedOffset - lineStart + 1 };
}
