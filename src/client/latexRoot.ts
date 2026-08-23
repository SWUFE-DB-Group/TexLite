/**
 * Return whether a LaTeX source contains a real documentclass declaration.
 * Comments and common verbatim-like environments are ignored so examples
 * inside listings do not turn a companion file into a root document.
 */
export function hasDocumentClass(source: string): boolean {
  const withoutComments = source.split(/(?<=\n)/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return line.slice(0, index) + (line.endsWith("\n") ? "\n" : "");
    }
    return line;
  }).join("");
  const withoutVerbatim = withoutComments
    .replace(/\\verb\*?([^\s]).*?\1/g, "")
    .replace(/\\begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}/g, "");
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(withoutVerbatim);
}
