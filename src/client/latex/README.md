# Internal LaTeX language module

TexLite's CodeMirror 6 LaTeX language uses a Lezer LR parser derived from
[Overleaf's lezer-latex](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/source-editor/lezer-latex).

Upstream revision: `e039ad26c5bf5422eb57b89fc7e57c75055e631d`.
The grammar and tokenizer are covered by AGPL-3.0; see the repository's
`LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Boundaries

- `latex.grammar` and `tokens.mjs` define the structural parser.
- `latex.mjs` and `latex.terms.mjs` are generated and checked in, like the
  internal BibTeX parser. Run `npm run generate:latex-parser` after changing
  the grammar. Development web startup, web builds, and tests generate them.
- `index.ts` supplies TexLite-specific highlighting, folding, and language
  data without importing Overleaf's application modules.
- `context.ts` provides cursor-local region and completion-argument context.
  It queries the current tree, allowing at most five milliseconds of catch-up
  parsing, and reports an unknown region when no reliable tree is available.
  Known argument nodes are used directly; compatibility scans are confined
  to commands identified within a window of 8,192 UTF-16 code units. This
  preserves multi-argument citations and package-defined reference commands
  through the existing shared command classifier and argument readers.
- Completion candidates, project dependencies, outline generation, reference
  navigation, math previews, formatting, and diagnostics remain separate.
  This parser does not expand TeX macros or decide whether a document compiles.
- Parser recovery nodes are not surfaced as compile or writing diagnostics.

## Local compatibility changes

The fork accepts whitespace around environment names and between `\begin` /
`\end` and their arguments. Its literal environment list covers TexLite's
existing `shared/latexLiterals.ts` list, with regression tests keeping the
two lists consistent. Inline raw content supports `\mintinline`, `\Verb`,
starred forms, options, nested braces, and escaped braces. Incomplete inline
literals stop at the end of the line so that subsequent prose remains usable.

Command tokens accept internal `@` names and colon-suffixed expl3 names
without swallowing ordinary math subscripts. Macro parameters can appear
in generic command definitions. The tokenizer does not keep a module-global
reference to the last parsed document.

Structural folding requires a real, matching environment end; an inferred
end from error recovery is not sufficient. Section folding leaves the next
heading on its own line. Existing environment scanning in `latexFolding.ts`
is retained for completion's end-pair reuse, not as the editor fold service.

Completion queries share one cursor-context result per request instead of
repeatedly materializing the document prefix. Comments and raw literal bodies
suppress suggestions, while argument and closing-delimiter boundaries resume
normal completion. Candidate indexes, snippets, and insertion/pair-reuse
behavior are unchanged. Reference decorations and navigation still use the
shared scanner; they have not yet been migrated to tree queries.

## Validation

Run the focused regression tests with:

```sh
npm test -- tests/latexParser.test.ts tests/latexContext.test.ts tests/latexSyntax.test.ts tests/latexCompletions.test.ts
```

The public upstream checkout does not contain the corpus/examples/regressions
directory referenced by its parser README. TexLite's tests therefore cover
representative document structures and existing regressions directly. The
incremental correctness test follows the `TreeFragment` workflow in Overleaf's
public `scripts/lezer-latex/test-incremental-parser.mjs`, comparing incremental
and fresh trees, including node positions, after insertions and deletions.
