import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { defaultHighlightStyle, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { buildParserFile } from "@lezer/generator";
import { highlightTree } from "@lezer/highlight";
import { findBibtexEntryKeys } from "../src/shared/bibtexReferences";
import {
  bibtexBracketMatching,
  bibtexCompletionSource,
  bibtexHoverInfoAt,
  bibtexLanguage,
  bibtexLinter,
  collectDocumentValues,
  defaultBibtexMessages,
  splitAuthors,
  type BibtexLinterOptions
} from "../src/client/bibtex";

function bibtexState(source: string, extensions: readonly Extension[] = []): EditorState {
  return EditorState.create({ doc: source, extensions: [bibtexLanguage, ...extensions] });
}

function syntaxErrors(state: EditorState): Array<{ from: number; to: number }> {
  const errors: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.type.isError) errors.push({ from: node.from, to: node.to });
    }
  });
  return errors;
}

function diagnostics(source: string, options: BibtexLinterOptions = {}) {
  const state = bibtexState(source);
  return bibtexLinter(options)({ state } as unknown as EditorView);
}

function applyOption(
  state: EditorState,
  option: Completion,
  from: number,
  to = from
): EditorState {
  if (typeof option.apply === "string" || option.apply === undefined) {
    return state.update({ changes: { from, to, insert: option.apply ?? option.label } }).state;
  }

  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch(transaction: Transaction) {
      current = transaction.state;
    }
  } as unknown as EditorView;
  option.apply(view, option, from, to);
  return current;
}

function applyCompletion(
  state: EditorState,
  completion: NonNullable<ReturnType<typeof bibtexCompletionSource>>,
  label: string,
  fallbackTo = completion.from
): EditorState {
  const option = completion.options.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`Missing completion: ${label}`);
  return applyOption(state, option, completion.from, completion.to ?? fallbackTo);
}

describe("internal BibTeX CodeMirror language", () => {
  it("keeps the checked-in parser synchronized with the upstream-style grammar", async () => {
    const grammar = await readFile(new URL("../src/client/bibtex/grammar/bibtex.grammar", import.meta.url), "utf8");
    const generated = buildParserFile(grammar, { moduleStyle: "es", exportName: "parser", warn: () => undefined });
    const header = "// Generated from grammar/bibtex.grammar; derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE.\n";
    await expect(readFile(new URL("../src/client/bibtex/generatedParser.mjs", import.meta.url), "utf8"))
      .resolves.toBe(header + generated.parser);
    await expect(readFile(new URL("../src/client/bibtex/generatedParser.terms.mjs", import.meta.url), "utf8"))
      .resolves.toBe(header + generated.terms);
  });

  it("parses the BibTeX forms and nested TeX escapes covered by the upstream grammar", () => {
    const source = String.raw`% A line comment
@string{cvpr = "Proceedings of CVPR"}
@preamble{"Generated \{ material \}"}
@comment{Nested {comment} with \{ escaped braces \}}
@inproceedings{garcia:2026/ref,
  author = {Garc{\'i}a and M{\"u}ller},
  title = {A title with \% punctuation},
  booktitle = cvpr # " 2026",
  year = 2026
}`;
    const state = bibtexState(source);
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter(node) {
        names.push(node.name);
      }
    });

    expect(syntaxErrors(state)).toEqual([]);
    expect(names).toEqual(expect.arrayContaining([
      "StringEntry", "PreambleEntry", "CommentEntry", "Entry", "BracedValue", "QuotedValue", "Concat", "Escape"
    ]));
    expect(names.filter((name) => name === "Entry")).toHaveLength(1);

    const highlighted: string[] = [];
    highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => highlighted.push(state.sliceDoc(from, to)));
    expect(highlighted).toContain("% A line comment");
  });

  it("supports case-insensitive special entries, numeric keys, paired delimiters, and comment folding", () => {
    const source = String.raw`@STRING{venue = "Nature"}
@pReAmBlE("Generated material")
@COMMENT{An opaque
  {comment body} with \{ escaped braces
}
@CoMmEnT(Another opaque
  parenthesized comment
)
@misc{2026paper,
  title = {Title}
}`;
    const state = bibtexState(source);
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        names.push(node.name);
      }
    });

    expect(syntaxErrors(state)).toEqual([]);
    expect(names).toEqual(expect.arrayContaining([
      "StringEntry", "PreambleEntry", "CommentEntry", "CommentBracedBlock", "CommentParenBlock", "Entry", "EntryKey"
    ]));

    const commentLine = state.doc.line(3);
    expect(foldable(state, commentLine.from, commentLine.to)).toMatchObject({
      from: expect.any(Number),
      to: state.doc.line(5).from
    });
    const parenCommentLine = state.doc.line(6);
    expect(foldable(state, parenCommentLine.from, parenCommentLine.to)).toMatchObject({
      from: expect.any(Number),
      to: state.doc.line(8).from
    });

    const highlighted: string[] = [];
    highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => highlighted.push(state.sliceDoc(from, to)));
    expect(highlighted.some((text) => text.includes("opaque"))).toBe(true);

    expect(syntaxErrors(bibtexState("@misc{key, title = {Title})"))).not.toEqual([]);
    expect(syntaxErrors(bibtexState("@misc(key, title = {Title}}"))).not.toEqual([]);
  });

  it("accepts ordinary text between entries without losing bibliography values or folds", () => {
    const source = `Exported bibliography: 文献库 {draft}.
% An ordinary line comment
@misc{first,
  title = {First entry}
}
Notes between entries, including unmatched braces } and quotes ".
@misc{second,
  title = {Second entry}
}
End of export.`;
    const state = bibtexState(source);
    expect(syntaxErrors(state)).toEqual([]);
    expect(diagnostics(source)).toEqual([]);
    expect([...collectDocumentValues(state).keys]).toEqual(["first", "second"]);
    expect(findBibtexEntryKeys(source).map((entry) => entry.key)).toEqual(["first", "second"]);
    const first = state.doc.line(3);
    expect(foldable(state, first.from, first.to)).toMatchObject({ to: state.doc.line(5).from });
  });

  it.each([
    "@misc{broken, title = {Unclosed value",
    "@misc{broken, title = {Closed value}",
    "@misc{broken, title {Missing assignment}}",
    "@misc{broken, title = }",
    "@misc broken",
    "@misc{broken, title = {Title})"
  ])("still diagnoses malformed entries following ordinary text: %s", (entry) => {
    const source = `Bibliography export.\n${entry}`;
    expect(diagnostics(source).some((diagnostic) => diagnostic.message === "Syntax error")).toBe(true);
  });

  it("agrees with the reference index on protected quotes in parenthesized entries", () => {
    const source = String.raw`@misc(simple, title="A {"} B")
@misc(nested, title="A {{"})} B")
@misc(escaped, title="Bj{\"o}rn and \"quoted\" text")
@misc{following, title={Next entry}}`;
    const state = bibtexState(source);
    expect(syntaxErrors(state)).toEqual([]);
    expect([...collectDocumentValues(state).keys]).toEqual(["simple", "nested", "escaped", "following"]);
    expect(findBibtexEntryKeys(source).map((entry) => entry.key)).toEqual([...collectDocumentValues(state).keys]);
  });

  it("supports parser-backed folds and bracket matching for nested bibliography values", () => {
    const source = String.raw`@inproceedings{rombach2022high,
  author = {Rombach, Robin and Ommer, Bj{\"o}rn},
  title = {High-resolution image synthesis}
}`;
    const state = bibtexState(source, [bibtexBracketMatching]);
    const opening = state.doc.line(1);
    const closing = state.doc.line(4);
    const fold = foldable(state, opening.from, opening.to);
    expect(fold).toMatchObject({ to: closing.from });
    expect(fold?.from).toBeLessThan(opening.to);

    const authorOpening = source.indexOf("{", source.indexOf("author"));
    const authorClosing = source.indexOf("},\n  title");
    expect(matchBrackets(state, authorClosing + 1, -1)).toMatchObject({
      start: { from: authorClosing, to: authorClosing + 1 },
      end: { from: authorOpening, to: authorOpening + 1 },
      matched: true
    });
  });

  it("reports syntax, duplicate, unknown-field, required-field and crossref diagnostics", () => {
    const source = String.raw`@article{duplicate,
  author = {Doe and Doe},
  title = {},
  unknownfield = {value}
}
@article{duplicate,
  title = {Second title}
}
@madeup{unknown, title = {Unknown type}}
@inproceedings{child, crossref = {parent}}
@article{broken, title = {Missing closing brace}`;
    const messages = diagnostics(source).map((diagnostic) => diagnostic.message);

    expect(messages).toEqual(expect.arrayContaining([
      "Duplicate name in author: Doe",
      "Empty value for field 'title'",
      "Unknown field: unknownfield",
      "Duplicate entry key: duplicate",
      "Unknown entry type: @madeup",
      expect.stringContaining("Verify 'crossref' provides:"),
      "Syntax error"
    ]));
  });

  it("honours diagnostic options and accepts localized diagnostic messages", () => {
    const source = "@article{key, title = {Title}, unknownfield = {value}}";
    expect(diagnostics(source, { checkUnknownFields: false }).map((diagnostic) => diagnostic.message))
      .not.toContain("Unknown field: unknownfield");

    const localized = diagnostics(source, {
      messages: { ...defaultBibtexMessages, unknownField: (field) => `已翻译字段：${field}` }
    }).map((diagnostic) => diagnostic.message);
    expect(localized).toContain("已翻译字段：unknownfield");
  });

  it.each(["@", "@misc{", "@misc{x, title={abc}", "@misc{x, title=\"abc"])(
    "keeps syntax diagnostics inside the document when an entry ends early: %s",
    (source) => {
      const errors = diagnostics(source).filter((diagnostic) => diagnostic.message === "Syntax error");
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) {
        expect(error.from).toBeGreaterThanOrEqual(0);
        expect(error.to).toBeGreaterThanOrEqual(error.from);
        expect(error.to).toBeLessThanOrEqual(source.length);
      }
    }
  );

  it("completes entry snippets only at a logical line start and prioritizes missing fields", () => {
    const atLineStart = bibtexState("@");
    const entryCompletion = bibtexCompletionSource(new CompletionContext(atLineStart, 1, true));
    expect(entryCompletion?.options.filter((option) => option.label === "@article")).toHaveLength(2);

    const inline = bibtexState("title = @");
    const inlineCompletion = bibtexCompletionSource(new CompletionContext(inline, inline.doc.length, true));
    expect(inlineCompletion?.options.filter((option) => option.label === "@article")).toHaveLength(1);

    const source = "@article{example,\n  title = {Existing},\n  \n}";
    const state = bibtexState(source);
    const completion = bibtexCompletionSource(new CompletionContext(state, source.length - 2, true));
    expect(completion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "author", type: "property" })
    ]));
    expect(completion?.options.some((option) => option.label === "title")).toBe(false);
  });

  it("inserts field-name completions as snippets instead of literal placeholder text", () => {
    const source = "@article{example,\n  \n}";
    const state = bibtexState(source);
    const position = source.indexOf("\n}");
    const completion = bibtexCompletionSource(new CompletionContext(state, position, true));
    expect(completion).not.toBeNull();

    const author = completion!.options.find((option) => option.label === "author");
    expect(typeof author?.apply).toBe("function");

    const completed = applyCompletion(state, completion!, "author");
    expect(completed.doc.toString()).toBe("@article{example,\n  author = {value}\n}");
    expect(completed.doc.toString()).not.toContain("${0:value}");
  });

  it("replaces a complete existing field name without inserting a second field assignment", () => {
    const source = "@article{example,\n  journal = {Old}\n}";
    const position = source.indexOf("jou") + "jou".length;
    const state = bibtexState(source).update({ selection: { anchor: position } }).state;
    const completion = bibtexCompletionSource(new CompletionContext(state, position, true));
    expect(completion).not.toBeNull();

    const completed = applyCompletion(state, completion!, "journal", position);
    expect(completed.doc.toString()).toBe("@article{example,\n  journal = {Old}\n}");
    expect(completed.doc.toString()).not.toContain("journal = {value} = {Old}");
    expect(completed.doc.toString()).not.toContain("journalrnal");
  });

  it("recognizes comments between an existing field name and its assignment", () => {
    const source = "@article{example,\n  jou % keep this comment\n  = {Old}\n}";
    const position = source.indexOf("jou") + "jou".length;
    const state = bibtexState(source).update({ selection: { anchor: position } }).state;
    const completion = bibtexCompletionSource(new CompletionContext(state, position, true));
    expect(completion).not.toBeNull();

    const completed = applyCompletion(state, completion!, "journal", position);
    expect(completed.doc.toString()).toBe("@article{example,\n  journal % keep this comment\n  = {Old}\n}");
    expect(completed.doc.toString()).not.toContain("journal = {value}");
  });

  it("keeps existing value delimiters and braces bare literal completions", () => {
    const source = String.raw`@article{source,
  journal = {Nature Communications}
}
@article{bare,
  journal = Nat
}
@article{quoted,
  journal = "Nat"
}`;
    const state = bibtexState(source);

    const barePosition = source.indexOf("journal = Nat") + "journal = Nat".length;
    const bareCompletion = bibtexCompletionSource(new CompletionContext(state, barePosition, true));
    expect(bareCompletion).not.toBeNull();
    const withBareValue = applyCompletion(state, bareCompletion!, "Nature Communications");
    expect(withBareValue.doc.toString()).toContain("journal = {Nature Communications}");

    const quotedPosition = source.lastIndexOf("Nat") + "Nat".length;
    const quotedCompletion = bibtexCompletionSource(new CompletionContext(state, quotedPosition, true));
    expect(quotedCompletion).not.toBeNull();
    const withQuotedValue = applyCompletion(state, quotedCompletion!, "Nature Communications");
    expect(withQuotedValue.doc.toString()).toContain("journal = \"Nature Communications\"");
  });

  it("keeps string macros bare and safely escapes inserted quoted values", () => {
    const source = String.raw`@string{venue = "Nature"}
@article{source, journal = {Journal of "Examples"}}
@article{macro-target, journal = ven}
@article{quoted-target, journal = "Jo"}`;
    const state = bibtexState(source);
    expect(collectDocumentValues(state).stringMacros).toEqual(new Set(["venue"]));

    const macroPosition = source.indexOf("journal = ven") + "journal = ven".length;
    const macroCompletion = bibtexCompletionSource(new CompletionContext(state, macroPosition, true));
    expect(macroCompletion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "venue", type: "constant" })
    ]));
    const withMacro = applyCompletion(state, macroCompletion!, "venue");
    expect(withMacro.doc.toString()).toContain("journal = venue");
    expect(withMacro.doc.toString()).not.toContain("journal = {venue}");

    const quotedPosition = source.lastIndexOf("Jo") + "Jo".length;
    const quotedCompletion = bibtexCompletionSource(new CompletionContext(state, quotedPosition, true));
    expect(quotedCompletion).not.toBeNull();
    const withQuotedValue = applyCompletion(state, quotedCompletion!, 'Journal of "Examples"');
    expect(withQuotedValue.doc.toString()).toContain(String.raw`journal = "Journal of \"Examples\""`);
    expect(syntaxErrors(withQuotedValue)).toEqual([]);
  });

  it.each(["{JA}", '"JA"'])("does not suggest macro references inside the literal %s", (literal) => {
    const source = `@string{JACM = {Journal of the ACM}}\n@misc{source, journal = JACM}\n@misc{target, journal = ${literal}}`;
    const state = bibtexState(source);
    const position = source.lastIndexOf("JA") + 2;
    const result = bibtexCompletionSource(new CompletionContext(state, position, true));
    expect(result).not.toBeNull();
    expect(result!.options.map((option) => option.label)).not.toContain("JACM");
    expect(collectDocumentValues(state).journals).not.toContain("JACM");
  });

  it("retains intentional literals with the same name as a macro", () => {
    const source = "@string{JACM = {Journal of the ACM}}\n@misc{source, journal = {JACM}}\n@misc{target, journal = {JA}}";
    const state = bibtexState(source);
    const result = bibtexCompletionSource(new CompletionContext(state, source.lastIndexOf("JA") + 2, true));
    expect(result).not.toBeNull();
    expect(result!.options).toContainEqual(expect.objectContaining({ label: "JACM", type: "text", apply: "JACM" }));
    expect(applyCompletion(state, result!, "JACM").doc.toString()).toContain("journal = {JACM}");
  });

  it.each(["author", "editor"])("invalidates cached %s choices at a top-level and separator", (field) => {
    const source = `@misc{prior, ${field} = {John Smith and Jane Doe}}\n@misc{target, ${field} = {John Smith}}`;
    let state = bibtexState(source);
    const position = source.lastIndexOf("John Smith") + "John Smith".length;
    const result = bibtexCompletionSource(new CompletionContext(state, position, true))!;
    expect(result).not.toBeNull();
    const isValid = (text: string) => typeof result.validFor === "function"
      ? result.validFor(text, result.from, result.from + text.length, state)
      : result.validFor?.test(text);
    const canUpdate = (text: string) => {
      const edited = state.update({ changes: { from: result.from, to: result.to!, insert: text } }).state;
      return result.update?.(result, result.from, result.from + text.length,
        new CompletionContext(edited, result.from + text.length, false)) != null;
    };
    expect(isValid("John Smith")).toBe(true);
    expect(canUpdate("John Smith an")).toBe(true);
    expect(isValid("John Smith and")).toBe(false);
    expect(canUpdate("John Smith and")).toBe(false);
    expect(isValid("John Smith AND Ja")).toBe(false);
    expect(canUpdate("John Smith Anderson")).toBe(true);

    state = state.update({ changes: { from: position, insert: " and Ja" } }).state;
    const next = bibtexCompletionSource(new CompletionContext(state, position + 7, false))!;
    expect(next).toMatchObject({ from: position + 5, to: position + 7 });
    expect(applyCompletion(state, next, "Jane Doe").doc.toString()).toContain(`${field} = {John Smith and Jane Doe}`);
  });

  it("refreshes the replacement range as whitespace is typed after a trailing and", () => {
    const source = "@misc{prior, author = {Jane Doe}}\n@misc{target, author = {John Smith and}}";
    const state = bibtexState(source);
    const position = source.lastIndexOf("and") + 3;
    const result = bibtexCompletionSource(new CompletionContext(state, position, true))!;
    expect(result.from).toBe(position);
    expect(typeof result.validFor).toBe("function");
    const validFor = result.validFor as Exclude<typeof result.validFor, RegExp | undefined>;
    expect(validFor("", position, position, state)).toBe(true);
    expect(validFor(" ", position, position + 1, state)).toBe(false);

    const spaced = state.update({ changes: { from: position, insert: " " } }).state;
    const refreshed = bibtexCompletionSource(new CompletionContext(spaced, position + 1, false))!;
    expect(refreshed.from).toBe(position + 1);
    expect(applyCompletion(spaced, refreshed, "Jane Doe").doc.toString()).toContain("author = {John Smith and Jane Doe}");
  });

  it.each([
    "@misc{key,\n  % editing jou▮\n}",
    "% example @art▮",
    "@comment{example @art▮}",
    "@comment(example @art▮)",
    "@COMMENT{nested {example @art▮}}",
    "@comment{unfinished @art▮"
  ])("suppresses completion in bibliography comments: %s", (marked) => {
    const position = marked.indexOf("▮");
    const state = bibtexState(marked.replace("▮", ""));
    expect(bibtexCompletionSource(new CompletionContext(state, position, true))).toBeNull();
    expect(bibtexCompletionSource(new CompletionContext(state, position, false))).toBeNull();
  });

  it.each([
    "@misc{key,\n  % editing\n  jou▮\n}",
    "@comment{example @article}\n@art▮",
    "@comment(example @article)\n@art▮",
    "@comment{example}@art▮"
  ])("resumes bibliography completion after a comment: %s", (marked) => {
    const position = marked.indexOf("▮");
    const state = bibtexState(marked.replace("▮", ""));
    expect(bibtexCompletionSource(new CompletionContext(state, position, true))?.options.length).toBeGreaterThan(0);
  });

  it.each(["{50% Na}", '"50% Na"'])("keeps percent signs literal in the field value %s", (literal) => {
    const source = `@misc{key, journal = ${literal}}`;
    const state = bibtexState(source);
    expect(bibtexCompletionSource(new CompletionContext(state, source.indexOf("Na") + 2, true))?.options)
      .toContainEqual(expect.objectContaining({ label: "Nature" }));
  });

  it("invalidates a bare-value popup when a percent comment starts", () => {
    const source = "@misc{key, journal = Na}";
    const state = bibtexState(source);
    const result = bibtexCompletionSource(new CompletionContext(state, source.indexOf("Na") + 2, true))!;
    expect(result).not.toBeNull();
    expect(typeof result.validFor).toBe("function");
    const validFor = result.validFor as Exclude<typeof result.validFor, RegExp | undefined>;
    expect(validFor("Na% comment", result.from, result.to!, state)).toBe(false);
  });

  it("uses traditional BibTeX fields in default entry templates", () => {
    const state = bibtexState("@");
    const completion = bibtexCompletionSource(new CompletionContext(state, 1, true));
    const articleSnippet = completion?.options
      .filter((option) => option.label === "@article")
      .find((option) => typeof option.apply === "function");
    expect(articleSnippet).toBeDefined();

    const completed = applyOption(state, articleSnippet!, completion!.from, completion!.to ?? completion!.from);
    expect(completed.doc.toString()).toContain("journal = {journal}");
    expect(completed.doc.toString()).toContain("year = {year}");
    expect(completed.doc.toString()).not.toContain("journaltitle");
    expect(completed.doc.toString()).not.toContain("date =");
  });

  it("collects document values for field, person, month and cross-reference completion", () => {
    const source = String.raw`@article{first,
  author = {Ada Lovelace and Grace Hopper},
  journal = {Journal of Examples},
  year = {2026}
}
@inproceedings{second,
  author = {Ada Lovelace and },
  crossref = {fir},
  month = {j}
}`;
    const state = bibtexState(source);
    const values = collectDocumentValues(state);
    expect(values.authors).toEqual(new Set(["Ada Lovelace", "Grace Hopper"]));
    expect(values.journals).toEqual(new Set(["Journal of Examples"]));
    expect(values.keys).toEqual(new Set(["first", "second"]));

    const authorCursor = source.lastIndexOf("Ada Lovelace and ") + "Ada Lovelace and ".length;
    const authorCompletion = bibtexCompletionSource(new CompletionContext(state, authorCursor, true));
    expect(authorCompletion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Grace Hopper" })
    ]));

    const crossrefCursor = source.indexOf("{fir}") + 4;
    const crossrefCompletion = bibtexCompletionSource(new CompletionContext(state, crossrefCursor, true));
    expect(crossrefCompletion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "first" })
    ]));

    const monthCursor = source.lastIndexOf("{j}") + 2;
    const monthCompletion = bibtexCompletionSource(new CompletionContext(state, monthCursor, true));
    expect(monthCompletion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "jan" })
    ]));
  });

  it("accepts common citation keys that include punctuation accepted by BibTeX", () => {
    const source = "@misc{Smith+2026, title = {A valid key}}";
    const state = bibtexState(source);

    expect(syntaxErrors(state)).toEqual([]);
    expect(collectDocumentValues(state).keys).toEqual(new Set(["Smith+2026"]));
    expect(diagnostics(source).map((diagnostic) => diagnostic.message)).not.toContain("Syntax error");
  });

  it("does not reuse concatenated BibTeX values as literal field text", () => {
    const source = String.raw`@string{venue = "Proceedings of Examples"}
@article{derived,
  journal = venue # " 2026",
  author = {Ada Lovelace}
}
@article{literal,
  journal = {Journal of Examples}
}`;
    const values = collectDocumentValues(bibtexState(source));

    expect(values.journals).toEqual(new Set(["Journal of Examples"]));
    expect(values.byField.get("journal")).toEqual(new Set(["Journal of Examples"]));
    expect(values.authors).toEqual(new Set(["Ada Lovelace"]));
  });

  it("keeps braced corporate authors intact and replaces complete value atoms", () => {
    expect(splitAuthors("{Research and Development} and Ada")).toEqual([
      "{Research and Development}", "Ada"
    ]);
    expect(splitAuthors(String.raw`{Research \and Development} and Ada and `)).toEqual([
      String.raw`{Research \and Development}`, "Ada"
    ]);

    const source = String.raw`@article{first,
  author = {{Research and Development} and Grace Hopper},
  journal = {Journal of Examples}
}
@article{second,
  author = {{Research and Development} and Gr},
  journal = {Journal of Ex}
}`;
    const state = bibtexState(source);
    const values = collectDocumentValues(state);
    expect(values.authors.has("{Research and Development}")).toBe(true);
    expect(values.authors.has("Grace Hopper")).toBe(true);
    expect(values.authors.has("{Research")).toBe(false);

    const journalCursor = source.lastIndexOf("Journal of Ex") + "Journal of Ex".length;
    const journalCompletion = bibtexCompletionSource(new CompletionContext(state, journalCursor, true));
    expect(journalCompletion).toMatchObject({
      from: source.lastIndexOf("{Journal of Ex}") + 1,
      to: source.lastIndexOf("{Journal of Ex}") + "{Journal of Ex".length
    });
    const withJournal = applyCompletion(state, journalCompletion!, "Journal of Examples");
    expect(withJournal.doc.toString()).toContain("journal = {Journal of Examples}");
    expect(withJournal.doc.toString()).not.toContain("Journal of Journal");

    const personCursor = source.lastIndexOf("Gr}") + 2;
    const personCompletion = bibtexCompletionSource(new CompletionContext(state, personCursor, true));
    expect(personCompletion).toMatchObject({
      from: source.lastIndexOf("Gr}"),
      to: source.lastIndexOf("Gr}") + 2
    });
    const withPerson = applyCompletion(state, personCompletion!, "Grace Hopper");
    expect(withPerson.doc.toString()).toContain("author = {{Research and Development} and Grace Hopper}");
  });

  it("preserves standalone braced corporate authors for reuse", () => {
    const corporateSource = String.raw`@article{corporate,
  author = {{Research and Development}}
}
@article{target,
  author = {Res}
}`;
    const corporateState = bibtexState(corporateSource);
    expect(collectDocumentValues(corporateState).authors).toEqual(
      new Set(["{Research and Development}", "Res"])
    );
    const corporateCursor = corporateSource.lastIndexOf("Res}") + "Res".length;
    const corporateCompletion = bibtexCompletionSource(new CompletionContext(corporateState, corporateCursor, true));
    expect(corporateCompletion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "{Research and Development}" })
    ]));
    const withCorporate = applyCompletion(corporateState, corporateCompletion!, "{Research and Development}");
    expect(withCorporate.doc.toString()).toContain("author = {{Research and Development}}");
  });

  it("exposes entry and field hover details while suppressing ignored fields", () => {
    const source = "@article{key, author = {Ada}, remote-id = {external}}";
    const state = bibtexState(source);
    expect(bibtexHoverInfoAt(state, source.indexOf("@article") + 2)).toMatchObject({
      kind: "entry", entryType: "article", requiredFields: expect.arrayContaining(["author", "title"])
    });
    expect(bibtexHoverInfoAt(state, source.indexOf("author") + 2)).toMatchObject({
      kind: "field", field: "author", example: "John Doe and Jane Smith", note: "authors"
    });
    expect(bibtexHoverInfoAt(state, source.indexOf("remote-id") + 2)).toBeNull();
  });
});
