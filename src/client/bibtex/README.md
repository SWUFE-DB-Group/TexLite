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
