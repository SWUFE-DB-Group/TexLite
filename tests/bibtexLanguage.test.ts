import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { defaultHighlightStyle, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { buildParserFile } from "@lezer/generator";
import { highlightTree } from "@lezer/highlight";
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

function applyCompletion(
  state: EditorState,
  completion: NonNullable<ReturnType<typeof bibtexCompletionSource>>,
  label: string
): EditorState {
  const option = completion.options.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`Missing completion: ${label}`);
  const from = completion.from;
  const to = completion.to ?? completion.from;

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
