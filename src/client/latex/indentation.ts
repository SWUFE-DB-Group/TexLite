import { delimitedIndent, flatIndent, indentNodeProp, type TreeIndentContext } from "@codemirror/language";

function environmentIndent(context: TreeIndentContext): number | null {
  const closing = /^\s*\\end\b/.test(context.textAfter);
  // Raw environments must not reindent code, filecontents or commented-out
  // source. Their actual closing marker can still align with the opening.
  if (context.node.name === "VerbatimEnvironment" && !closing) return null;
  return context.baseIndent + (closing ? 0 : context.unit);
}

function literalIndent(context: TreeIndentContext): number | null {
  const environment = context.node.parent?.parent;
  const end = environment?.name === "VerbatimEnvironment" ? environment.getChild("EndEnv") : null;
  const text = context.textAfter;
  const leading = text.length - text.trimStart().length;
  // Whitespace before the actual \end belongs to VerbatimContent. Dedent
  // that line, but never a raw line merely containing an example \end.
  return end && end.from < end.to && end.from === context.pos + leading && /^\s*\\end\b/.test(text)
    ? context.baseIndentFor(environment!) : null;
}

/** Basic editing indentation, not a document formatter or macro interpreter. */
export const latexIndentation = indentNodeProp.add({
  $Environment: environmentIndent,
  // Keep the paper body at the document margin, not indented as one huge block.
  DocumentEnvironment: flatIndent,
  $Section: (context) => context.continue(),
  "Group NonEmptyGroup TextArgument DefinitionArgument MathArgument SectioningArgument ShortTextArgument": delimitedIndent({ closing: "}", align: false }),
  OptionalArgument: delimitedIndent({ closing: "]", align: false }),
  BracketMath: delimitedIndent({ closing: "\\]", align: false }),
  ParenMath: delimitedIndent({ closing: "\\)", align: false }),
  VerbatimContent: literalIndent,
  "VerbContent LstInlineContent": () => null
});
