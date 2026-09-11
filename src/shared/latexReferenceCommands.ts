/**
 * Declarative classification for the small set of LaTeX commands that carry
 * citation keys or cross-reference labels. The generic fallbacks deliberately
 * preserve support for package-defined commands such as `\\smartcite` and
 * `\\myref`, while exact entries cover commands whose arguments differ from
 * their name-based convention.
 */

export type LatexReferenceKind = "citation" | "label";

export type LatexReferenceArgumentKind = "mandatory" | "optional";

export interface LatexReferenceCommandSpec {
  kind: LatexReferenceKind;
  argumentKind: LatexReferenceArgumentKind;
  /** Number of key-bearing arguments; multicite commands use a large bound. */
  maximumArguments: number;
}

const singleCitation: LatexReferenceCommandSpec = {
  kind: "citation",
  argumentKind: "mandatory",
  maximumArguments: 1
};

const multipleCitation: LatexReferenceCommandSpec = {
  kind: "citation",
  argumentKind: "mandatory",
  maximumArguments: Number.MAX_SAFE_INTEGER
};

const singleLabel: LatexReferenceCommandSpec = {
  kind: "label",
  argumentKind: "mandatory",
  maximumArguments: 1
};

const rangeLabel: LatexReferenceCommandSpec = {
  kind: "label",
  argumentKind: "mandatory",
  maximumArguments: 2
};

const optionalLabel: LatexReferenceCommandSpec = {
  kind: "label",
  argumentKind: "optional",
  maximumArguments: 1
};

/**
 * `null` explicitly means a command must never be interpreted as a reference.
 * Several biblatex setup commands contain “cite”, but their braced arguments
 * configure rendering or define commands instead of naming bibliography keys.
 */
const exactReferenceCommands: Readonly<Record<string, LatexReferenceCommandSpec | null>> = {
  href: null,
  hyperref: optionalLabel,
  crefrange: rangeLabel,
  citestyle: null,
  setcitestyle: null,
  newcites: null,
  citetext: null,
  declarecitecommand: null,
  declaremulticitecommand: null,
  declareautocitecommand: null,
  declarecitewrappercommand: null,
  declarecitepunctuation: null,
  declarecitedelimiter: null,
  declarecitedriver: null,
  declarecitealias: null,
  ateverycite: null,
  ateverycitekey: null,
  atnextcite: null,
  atnextcitekey: null
};

/**
 * Return the key-bearing argument shape for a command, or null when it is not
 * a reference command. Command names are case-insensitive for classification;
 * the original spelling remains available to callers for display and links.
 */
export function classifyLatexReferenceCommand(name: string): LatexReferenceCommandSpec | null {
  const normalized = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(exactReferenceCommands, normalized)) {
    return exactReferenceCommands[normalized] ?? null;
  }

  if (normalized === "nocite" || normalized.includes("cite")) {
    return normalized.endsWith("cites") ? multipleCitation : singleCitation;
  }
  if (normalized === "ref" || normalized.endsWith("ref")) return singleLabel;
  return null;
}
