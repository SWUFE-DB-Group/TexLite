# Third-party notices

## Overleaf lezer-latex

TexLite's internal LaTeX editor parser derives from the grammar and tokenizer
in [Overleaf's lezer-latex](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/source-editor/lezer-latex),
by Overleaf contributors, at revision
`e039ad26c5bf5422eb57b89fc7e57c75055e631d`.

The derived sources and generated parser live in `src/client/latex/`.
TexLite modifies literal-content handling, command and environment tokens,
and provides its own CodeMirror language integration. The incremental tests
also follow the workflow of Overleaf's public parser test script.

These components are distributed under the GNU Affero General Public License,
version 3. The license text is included in TexLite's `LICENSE`; the original
upstream license is available in
[Overleaf's repository](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/LICENSE).

## TeXlyre/codemirror-lang-bib

TexLite's internal BibTeX CodeMirror language module derives from
[TeXlyre/codemirror-lang-bib](https://github.com/TeXlyre/codemirror-lang-bib)
by Fares Abawi. The derived files retain the upstream MIT notice.

Copyright (c) 2025 Fares Abawi

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
