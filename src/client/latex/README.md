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
- `indentation.ts` provides basic environment/group indentation and closing
  marker alignment, while preserving literal contents and the document margin.
- `highlighting.ts` defines semantic highlight tags and visible-tree
  decorations. LaTeX uses its own palette, not CodeMirror's default colors;
  CSS variables in `styles.css` control commands, environments, reference
  keys, special characters, comments, brackets, and raw-text backgrounds.
  Math command accents use existing syntax nodes without tinting whole regions, while
  comment task markers inspect only visible comment text. This layer does
  not force additional parsing or scan a whole-document source string.
  Cursor-local environment pairing accents only real matching begin/end
  markers, excluding subsequent options and inferred recovery nodes.
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
`\end` and their arguments. Common command arguments also accept line breaks
and spaces, and macro/environment definitions support their starred forms.
Options and following mandatory arguments may be separated by spaces,
line breaks, or comments in image inclusion, captions, and titles. `\let`
accepts spacing before the aliased command, and starred math tags retain
their text-argument boundaries across the same separators.
Definition fragments retain macro parameters without interpreting unbalanced
environment or math markers as document structure. Unbraced input paths stop
at whitespace and comments rather than swallowing following commands.
Its literal environment list covers TexLite's
existing `shared/latexLiterals.ts` list, with regression tests keeping the
two lists consistent. Inline raw content supports `\mintinline`, `\Verb`,
starred forms, options, nested braces, and escaped braces. Incomplete inline
literals stop at the end of the line so that subsequent prose remains usable.

Command tokens accept internal `@` names and colon-suffixed expl3 names
without swallowing ordinary math subscripts. Macro parameters can appear
in generic command definitions. The tokenizer does not keep a module-global
reference to the last parsed document.

Structural folding requires a real, matching environment end; an inferred
end from error recovery is not sufficient. Matching uses parsed environment
names so comments in their groups do not disable folding. Multiline section
titles and opening environment names remain visible; body folding starts on
their final line. Section folding leaves the next heading on its own line.
Existing environment scanning in `latexFolding.ts`
is retained for completion's end-pair reuse, not as the editor fold service.
It recognizes multiline/comment-separated begin/end arguments and preserves
balanced outer environments rather than inserting duplicate end commands or
stealing an outer close.

Completion queries share one cursor-context result per request instead of
repeatedly materializing the document prefix. Comments and raw literal bodies
suppress suggestions, while argument and closing-delimiter boundaries resume
normal completion. Live-source and server project candidates use the pure
`src/shared/latexSymbols.ts` extractor and shared completion data types. Built-ins,
cache ownership, source attribution and bibliography scope stay with each caller;
snippet insertion and end-pair reuse stay in the editor. Reference decorations and navigation still use the
shared scanner; they have not yet been migrated to tree queries.
The reference-mark view plugin owns a prefix cache and a cancellable 120 ms
debounce for edits and new viewport coverage. Unaffected visible marks are
retained during typing; potentially invalid suffix marks disappear immediately,
while syntax colors remain tree-driven. Deferred results are document-identity
checked. Clicks during the debounce revalidate the selected reference, and
destroying or disabling a view cancels its pending work.
Auto-pair input handlers first reuse their line-local environment/delimiter
predicates. Ordinary input does not flatten the document; real candidates still
perform the full literal-context and existing-end checks.
When recovery moves an unfinished known-environment end name outside its
argument node, an adjacent recovered marker permits the same bounded fallback.
Completed environments and ordinary prose do not enable this recovery path.

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
