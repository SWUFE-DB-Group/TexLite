# Internal BibTeX CodeMirror support

This module is TexLite's internal CodeMirror 6 implementation for `.bib`
files. It is derived from the MIT-licensed
[TeXlyre/codemirror-lang-bib](https://github.com/TeXlyre/codemirror-lang-bib)
source; the adjacent `LICENSE` preserves its attribution.

`grammar/bibtex.grammar` is the parser source of truth. Run
`npm run generate:bibtex-parser` after changing it. The generated `.mjs`
artifacts are checked in so production and development builds do not need a
runtime parser generator.

The module owns BibTeX-specific parsing, highlighting, folding, diagnostics,
completion data and hover information. `LatexEditor` deliberately continues to
own shared CodeMirror behaviour such as editor keymaps, autocomplete UI,
close-brackets and indentation so `.tex` and `.bib` files behave consistently.

Completion uses parser context to suppress line/entry comments, refresh person
choices at top-level `and` separators, and offer `@string` references only in
bare values. Literal values retain their braces/quotes and protected inner
groups. Indentation rules distinguish entry and value closers, including
parenthesized entries; the shared editor applies them on newline and input.

The focused regression suite is in `tests/bibtexLanguage.test.ts` and
`tests/bibtexIndentation.test.ts`.
