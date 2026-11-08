/**
 * Readable text for a BibTeX field value, for display only.
 *
 * Bibliography fields are TeX: braces protect capitalization (`{BERT}`),
 * accents are commands (`{\"o}`), and punctuation has TeX spellings (`--`,
 * `~`, `\&`). Previews and cards show the text a reader expects instead of the
 * markup. The conversion is deliberately small and lossy: it covers what
 * bibliography databases commonly contain, keeps math (`$...$`) verbatim, and
 * keeps the name of a command it does not know rather than hiding text. The
 * stored BibTeX is never rewritten; this is only applied where text is shown.
 */

/** Combining marks for TeX's accent commands; NFC composes them where Unicode can. */
const accents: Readonly<Record<string, string>> = {
  "\"": "̈", "'": "́", "`": "̀", "^": "̂", "~": "̃",
  "=": "̄", ".": "̇", u: "̆", v: "̌", H: "̋",
  c: "̧", k: "̨", r: "̊", d: "̣", b: "̱"
};

/** Letter-like control words that stand for a character. */
const symbols: Readonly<Record<string, string>> = {
  ss: "ß", SS: "SS", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ",
  aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ", dh: "ð", DH: "Ð",
  th: "þ", TH: "Þ", ng: "ŋ", NG: "Ŋ",
  textendash: "–", textemdash: "—", textquoteleft: "‘", textquoteright: "’",
  textquotedblleft: "“", textquotedblright: "”", textbackslash: "\\",
  textasciitilde: "~", textunderscore: "_", textbar: "|", dag: "†", ddag: "‡",
  S: "§", P: "¶", copyright: "©", textregistered: "®", texttrademark: "™",
  ldots: "…", dots: "…", textellipsis: "…", relax: "", noindent: "", protect: ""
};

/**
 * Words written as commands. TeX would swallow the space after them, but a
 * reader expects `\LaTeX is` to show as two words, so the space is kept.
 */
const logos: Readonly<Record<string, string>> = {
  TeX: "TeX", LaTeX: "LaTeX", LaTeXe: "LaTeX2ε", BibTeX: "BibTeX", XeTeX: "XeTeX", LuaTeX: "LuaTeX"
};

/** Commands whose argument is sorting or formatting data, never shown. */
const hiddenArgument = new Set(["noopsort", "sortnoop", "SortNoop", "noop"]);

/** Control symbols (`\` + punctuation) that print their character, or nothing. */
const controlSymbols: Readonly<Record<string, string>> = {
  "&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}",
  " ": " ", "\\": " ", ",": " ", ";": " ", ":": " ", "!": "", "-": "", "/": "", "@": ""
};

export function bibtexDisplayText(value: string): string {
  return convert(value).normalize("NFC").replace(/[ \t\r\n]+/g, " ").trim();
}

function convert(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const command = readCommand(source, index);
      output += command.text;
      index = command.end;
      continue;
    }
    if (character === "$") {
      const close = closingDollar(source, index + 1);
      output += source.slice(index, close);
      index = close;
      continue;
    }
    if (character === "{" || character === "}") {
      index += 1;
      continue;
    }
    if (character === "~") {
      output += " ";
      index += 1;
      continue;
    }
    if (character === "-") {
      let end = index;
      while (source[end] === "-") end += 1;
      const run = end - index;
      output += run === 2 ? "–" : run === 3 ? "—" : source.slice(index, end);
      index = end;
      continue;
    }
    if ((character === "`" || character === "'") && source[index + 1] === character) {
      output += character === "`" ? "“" : "”";
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** End of a `$...$` span (after its closing `$`), or the end of the source when unclosed. */
function closingDollar(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "$") return index + 1;
  }
  return source.length;
}

function readCommand(source: string, start: number): { text: string; end: number } {
  const next = source[start + 1];
  if (next === undefined) return { text: "", end: start + 1 };
  if (!/[A-Za-z]/.test(next)) {
    if (next in accents) return applyAccent(source, start + 2, accents[next], false);
    return { text: controlSymbols[next] ?? next, end: start + 2 };
  }
  let nameEnd = start + 1;
  while (nameEnd < source.length && /[A-Za-z]/.test(source[nameEnd])) nameEnd += 1;
  const name = source.slice(start + 1, nameEnd);
  // TeX skips the spaces after a control word, so `\ss e` reads as `ße`.
  const end = skipSpaces(source, nameEnd);
  if (name in accents) return applyAccent(source, nameEnd, accents[name], true);
  if (name in symbols) return { text: symbols[name], end };
  if (name in logos) return { text: logos[name], end: source[end] === "{" ? end : nameEnd };
  if (hiddenArgument.has(name)) {
    const group = source[end] === "{" ? groupEnd(source, end) : end;
    return { text: "", end: skipSpaces(source, group) };
  }
  // `\emph{x}`, `\textsc{x}`, `\url{x}` and unknown commands with an argument
  // show the argument; the braces are dropped by the caller.
  if (source[end] === "{") return { text: "", end };
  // An unknown command without an argument keeps its name and the space after it.
  return { text: name, end: nameEnd };
}

function applyAccent(source: string, start: number, mark: string, wordAccent: boolean): { text: string; end: number } {
  const index = wordAccent ? skipSpaces(source, start) : start;
  let base: string;
  let end: number;
  if (source[index] === "{") {
    end = groupEnd(source, index);
    base = convertAccentBase(source.slice(index + 1, end - 1));
  } else if (source[index] === "\\") {
    const command = readCommand(source, index);
    base = dotless(command.text);
    end = command.end;
  } else if (index < source.length) {
    base = source[index];
    end = index + 1;
  } else {
    return { text: "", end: index };
  }
  if (!base) return { text: "", end };
  const first = String.fromCodePoint(base.codePointAt(0)!);
  return { text: first + mark + base.slice(first.length), end };
}

function convertAccentBase(value: string): string {
  return dotless(convert(value).trim());
}

/** `\'{\i}` is an accented i: put the accent on a dotted letter so NFC composes it. */
function dotless(value: string): string {
  return value.replace(/^ı/, "i").replace(/^ȷ/, "j");
}

function skipSpaces(source: string, index: number): number {
  while (index < source.length && /[ \t\r\n]/.test(source[index])) index += 1;
  return index;
}

/** Index after the brace that closes the group opened at `start`. */
function groupEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return source.length;
}
