/** Lightweight extraction of source and bibliography dependencies from TeX. */

import { forEachLatexCommand, readLatexMandatoryArguments, type LatexArgumentSpan } from "./latexScanner.js";

export interface LatexPathReference {
  path: string;
  command: string;
  from: number;
  to: number;
}

function pathRanges(source: string, argument: LatexArgumentSpan, splitOnComma: boolean): LatexPathReference[] {
  const paths: LatexPathReference[] = [];
  let segmentStart = argument.contentFrom;
  for (let index = argument.contentFrom; index <= argument.contentTo; index += 1) {
    if (index !== argument.contentTo && (!splitOnComma || source[index] !== ",")) continue;
    let from = segmentStart;
    let to = index;
    while (from < to && /\s/.test(source[from])) from += 1;
    while (to > from && /\s/.test(source[to - 1])) to -= 1;
    if (to > from) paths.push({ path: source.slice(from, to), command: "", from, to });
    segmentStart = index + 1;
  }
  return paths;
}

/**
 * Find source files pulled into a LaTeX document. Paths intentionally remain
 * raw: project-level code is responsible for resolving them safely.
 */
export function findLatexSourceIncludes(source: string): LatexPathReference[] {
  const includes: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name === "input" || name === "include" || name === "subfile") {
      const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const include of pathRanges(source, argument, false)) includes.push({ ...include, command: command.name });
      return;
    }
    if (name !== "import" && name !== "subimport" && name !== "includefrom" && name !== "inputfrom") return;
    const argumentsFound = readLatexMandatoryArguments(source, command.to, 2);
    if (argumentsFound.length !== 2) return;
    const directory = source.slice(argumentsFound[0].contentFrom, argumentsFound[0].contentTo).trim();
    const file = source.slice(argumentsFound[1].contentFrom, argumentsFound[1].contentTo).trim();
    if (!directory || !file) return;
    const separator = directory.endsWith("/") ? "" : "/";
    includes.push({
      path: directory + separator + file,
      command: command.name,
      from: argumentsFound[1].contentFrom,
      to: argumentsFound[1].contentTo
    });
  });
  return includes;
}

/** Find bibliography resources declared by a LaTeX document. */
export function findLatexBibliographyFiles(source: string): LatexPathReference[] {
  const files: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name !== "bibliography" && name !== "addbibresource" && name !== "addglobalbib" && name !== "addsectionbib") return;
    const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
    if (!argument) return;
    const splitOnComma = name === "bibliography";
    for (const file of pathRanges(source, argument, splitOnComma)) files.push({ ...file, command: command.name });
  });
  return files;
}
