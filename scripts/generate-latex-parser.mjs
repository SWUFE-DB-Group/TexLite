import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParserFile } from "@lezer/generator";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/client/latex");
const grammar = await fs.readFile(path.join(directory, "latex.grammar"), "utf8");
const generated = buildParserFile(grammar, { moduleStyle: "es", exportName: "parser" });
const header = "// Generated from latex.grammar; derived from Overleaf (AGPL-3.0). See THIRD_PARTY_NOTICES.md.\n";

async function writeIfChanged(name, content) {
  const target = path.join(directory, name);
  try {
    if (await fs.readFile(target, "utf8") === content) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(target, content, "utf8");
}

await Promise.all([
  writeIfChanged("latex.mjs", header + generated.parser),
  writeIfChanged("latex.terms.mjs", header + generated.terms)
]);
