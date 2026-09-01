import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Application-level tests exercise successful compilation and SyncTeX routes.
// Keep them independent from a host TeX Live installation so that the same
// suite runs locally and in CI. Individual compiler tests can still provide a
// purpose-built executable when they need to inspect compiler arguments.
const toolsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-test-tools-"));
process.env.PATH = `${toolsDirectory}${path.delimiter}${process.env.PATH ?? ""}`;

writeExecutable("latexmk", `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const outputArgument = process.argv.find((argument) => argument.startsWith("-outdir="));
if (!outputArgument) {
  console.error("fake latexmk requires -outdir");
  process.exit(2);
}
const outputDirectory = outputArgument.slice("-outdir=".length);
const mainFile = process.argv.at(-1);
if (!mainFile || !/\\.tex$/i.test(mainFile)) {
  console.error("fake latexmk requires a .tex main file");
  process.exit(2);
}
const stem = path.basename(mainFile).replace(/\\.tex$/i, "");
const source = fs.readFileSync(mainFile, "utf8");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, stem + ".pdf"), "%PDF-1.4\\n% TexLite test fixture\\n" + source);
fs.writeFileSync(
  path.join(outputDirectory, stem + ".synctex.gz"),
  gzipSync("SyncTeX Version:1\\nInput:1:" + path.resolve(mainFile) + "\\n")
);
console.log("Fake latexmk completed.");
`);

writeExecutable("synctex", `#!/usr/bin/env node
import path from "node:path";

const operation = process.argv[2];
if (operation === "view") {
  console.log("Page:1\\nx:42\\ny:84\\nW:10\\nH:12");
  process.exit(0);
}
if (operation === "edit") {
  const outputIndex = process.argv.indexOf("-o");
  const location = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  const pdfPath = location.split(":").slice(3).join(":");
  const source = path.resolve(path.basename(pdfPath).replace(/\\.pdf$/i, ".tex"));
  console.log("Input:" + source + "\\nLine:4\\nColumn:1");
  process.exit(0);
}
console.error("unsupported fake synctex operation");
process.exit(2);
`);

function writeExecutable(name: string, source: string): void {
  const executable = path.join(toolsDirectory, name);
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
}
