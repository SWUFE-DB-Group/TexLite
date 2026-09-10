export interface LatexCommandArgument {
  optional: boolean;
}

function skipWhitespace(source: string, position: number): number {
  let cursor = position;
  while (/[ \t\r\n]/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

export function readBalancedLatexArgument(source: string, start: number, open = "{", close = "}"): { from: number; to: number; content: string } | null {
  const from = skipWhitespace(source, start);
  if (source[from] !== open) return null;
  let depth = 1;
  for (let cursor = from + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === open) depth += 1;
    else if (source[cursor] === close && --depth === 0) {
      return { from, to: cursor + 1, content: source.slice(from + 1, cursor) };
    }
  }
  return null;
}

export function commandSnippet(name: string, arguments_: LatexCommandArgument[]): string | undefined {
  if (arguments_.length === 0) return undefined;
  return name + arguments_.map((argument, index) => {
    const placeholder = `\${${index + 1}}`;
    return argument.optional ? `[${placeholder}]` : `{${placeholder}}`;
  }).join("");
}

export function newCommandArguments(argumentCount: number, hasDefault: boolean): LatexCommandArgument[] {
  if (!Number.isFinite(argumentCount) || argumentCount <= 0) return [];
  if (!hasDefault) return Array.from({ length: argumentCount }, () => ({ optional: false }));
  return [{ optional: true }, ...Array.from({ length: Math.max(0, argumentCount - 1) }, () => ({ optional: false }))];
}

/**
 * Interpret only xparse forms that have a safe ordinary LaTeX insertion. For
 * delimiter, verbatim, star, and token arguments, omit a snippet rather than
 * generate invalid syntax.
 */
export function xparseCommandArguments(specification: string): LatexCommandArgument[] | null {
  const result: LatexCommandArgument[] = [];
  for (let cursor = 0; cursor < specification.length;) {
    const character = specification[cursor];
    if (/[ \t\r\n+\-!]/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "m") {
      result.push({ optional: false });
      cursor += 1;
      continue;
    }
    if (character === "o") {
      result.push({ optional: true });
      cursor += 1;
      continue;
    }
    if (character === "O") {
      const defaultValue = readBalancedLatexArgument(specification, cursor + 1);
      if (!defaultValue) return null;
      result.push({ optional: true });
      cursor = defaultValue.to;
      continue;
    }
    return null;
  }
  return result;
}

export interface XparseCommandDefinition {
  name: string;
  specification: string;
}

const xparseDeclaration = /\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareExpandableDocumentCommand|RenewExpandableDocumentCommand|ProvideExpandableDocumentCommand)\b/g;

export function xparseCommandDefinitions(source: string): XparseCommandDefinition[] {
  const definitions: XparseCommandDefinition[] = [];
  for (const match of source.matchAll(xparseDeclaration)) {
    const target = readBalancedLatexArgument(source, match.index + match[0].length);
    if (!target) continue;
    const name = /^\s*\\([A-Za-z@][A-Za-z@0-9:_]*)\s*$/.exec(target.content)?.[1];
    if (!name) continue;
    const specification = readBalancedLatexArgument(source, target.to);
    if (!specification) continue;
    definitions.push({ name, specification: specification.content });
  }
  return definitions;
}
