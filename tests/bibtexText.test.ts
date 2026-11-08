import { describe, expect, it } from "vitest";
import { bibtexDisplayText } from "../src/shared/bibtexText";

describe("BibTeX display text", () => {
  it("drops protective braces and collapses whitespace", () => {
    expect(bibtexDisplayText("{{BERT}: Pre-training of {D}eep\n  Nets}")).toBe("BERT: Pre-training of Deep Nets");
  });

  it.each([
    [`G{\\"o}del`, "Gödel"],
    [`G\\"odel`, "Gödel"],
    [`Erd{\\H{o}}s`, "Erdős"],
    [`Erd\\H os`, "Erdős"],
    [`Fran\\c{c}ois`, "François"],
    [`\\v{C}ech`, "Čech"],
    [`Andr\\'{e}`, "André"],
    [`Mart\\'{\\i}nez`, "Martínez"],
    [`Mart\\'\\i nez`, "Martínez"],
    [`Stra\\ss e`, "Straße"],
    [`{\\O}rsted and {\\aa}`, "Ørsted and å"],
    [`\\L{}ukasiewicz`, "Łukasiewicz"]
  ])("converts accents and special letters: %s", (source, text) => {
    expect(bibtexDisplayText(source)).toBe(text);
  });

  it("converts TeX punctuation", () => {
    expect(bibtexDisplayText("Pages 1--2 --- R\\&D, 50\\% off, A~B ``quoted''")).toBe("Pages 1–2 — R&D, 50% off, A B “quoted”");
  });

  it("keeps the argument of formatting commands and hides sorting arguments", () => {
    expect(bibtexDisplayText("\\emph{Deep} \\textsc{Nets} with \\url{x.org}")).toBe("Deep Nets with x.org");
    expect(bibtexDisplayText("{\\noopsort{1973b}}Second")).toBe("Second");
    expect(bibtexDisplayText("The \\LaTeX{} Companion")).toBe("The LaTeX Companion");
  });

  it("keeps math and unknown commands visible rather than hiding text", () => {
    expect(bibtexDisplayText("$\\alpha$-helix {$O(n)$}")).toBe("$\\alpha$-helix $O(n)$");
    expect(bibtexDisplayText("The \\unknowncommand here")).toBe("The unknowncommand here");
    expect(bibtexDisplayText("Using \\LaTeX and \\BibTeX{} together")).toBe("Using LaTeX and BibTeX together");
  });

  it("tolerates incomplete markup", () => {
    expect(bibtexDisplayText("Open {group")).toBe("Open group");
    expect(bibtexDisplayText("Trailing \\")).toBe("Trailing");
    expect(bibtexDisplayText("Accent \\'")).toBe("Accent");
    expect(bibtexDisplayText("$unclosed math")).toBe("$unclosed math");
  });
});
