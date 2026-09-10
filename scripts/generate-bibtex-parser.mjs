import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParserFile } from "@lezer/generator";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const grammarPath = path.join(repositoryRoot, "src", "client", "bibtex", "grammar", "bibtex.grammar");
const outputDirectory = path.join(repositoryRoot, "src", "client", "bibtex");

async function writeIfChanged(filePath, content) {
  try {
    if (await fs.readFile(filePath, "utf8") === content) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(filePath, content, "utf8");
}

const grammar = await fs.readFile(grammarPath, "utf8");
const generated = buildParserFile(grammar, {
  moduleStyle: "es",
  exportName: "parser",
  warn: (warning) => console.warn(`BibTeX grammar: ${warning}`)
});

const header = "// Generated from grammar/bibtex.grammar; derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE.\n";
await Promise.all([
  writeIfChanged(path.join(outputDirectory, "generatedParser.mjs"), header + generated.parser),
  writeIfChanged(path.join(outputDirectory, "generatedParser.terms.mjs"), header + generated.terms)
]);
