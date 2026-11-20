import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

/** Opt in only for suites exercising compiler/SyncTeX routes without TeX Live. */
export function useFakeTexTools(): void {
  let directory: string | undefined;
  let previousPath: string | undefined;

  beforeAll(() => {
    previousPath = process.env.PATH;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-test-tools-"));
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
    writeExecutable(directory, "latexmk", latexmkSource);
    writeExecutable(directory, "synctex", synctexSource);
  });

  // Registered at the suite's outer scope, after nested application teardown.
  afterAll(() => {
    if (!directory) return;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      directory = undefined;
    }
  });
}

function writeExecutable(directory: string, name: string, source: string): void {
  const executable = path.join(directory, name);
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
}

const latexmkSource = `#!/usr/bin/env node
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
`;

const synctexSource = `#!/bin/sh
set -e

mode="$1"
location=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    location="$1"
    break
  fi
  shift
done
if [ "$mode" = edit ]; then
  pdfPath="$(printf '%s' "$location" | sed 's/^.*:[^:]*:[^:]*://')"
else
  pdfPath="$location"
fi
# Test documents can mark an otherwise fixed mapping to identify which
# immutable PDF the caller passed to SyncTeX.
marker="$(sed -n 's/^% synctex-test-location: \\([0-9][0-9]*\\)$/\\1/p' "$pdfPath")"
case "$mode" in
  view)
    printf '%s\\n' "Page:\${marker:-1}" 'x:42' 'y:84' 'W:10' 'H:12'
    ;;
  edit)
    stem="$(basename "$pdfPath" .pdf)"
    printf 'Input:%s/%s.tex\\nLine:%s\\nColumn:1\\n' "$(pwd)" "$stem" "\${marker:-4}"
    ;;
  *)
    printf '%s\\n' 'unsupported fake synctex operation' >&2
    exit 2
    ;;
esac
`;
