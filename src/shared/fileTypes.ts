export const MAX_TEXT_EDITOR_BYTES = 5 * 1024 * 1024;

const textExtensions = new Set([
  "tex", "latex", "ltx", "bib", "bibtex", "bst", "sty", "cls", "dtx", "ins", "def", "fd",
  "aux", "bbl", "blg", "log", "toc", "lof", "lot", "idx", "ilg", "ind", "nav", "snm", "out", "vrb",
  "txt", "text", "dat", "csv", "tsv", "md", "markdown", "mdown", "mkdn", "rst", "ps", "eps",
  "json", "jsonc", "json5", "jsonl", "ipynb", "yaml", "yml", "toml", "ini", "cfg", "conf", "cnf", "env", "properties", "rc", "lock",
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "m", "mm", "cs", "java", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
  "py", "pyw", "pyi", "r", "rmd", "qmd", "jl", "pl", "pm", "rb", "go", "rs", "lua", "php", "sh", "bash", "zsh", "ksh", "fish",
  "bashrc", "zshrc", "profile", "awk", "sed", "ps1", "psm1", "bat", "cmd", "sql", "html", "htm", "xhtml", "css", "scss", "sass", "less",
  "xml", "xsd", "xsl", "xslt", "graphql", "gql", "proto", "cmake", "mk", "diff", "patch", "srt", "vtt", "asc", "pem"
]);
const textNames = new Set([
  "latexmkrc", ".latexmkrc", "readme", "license", "licence", "copying", "authors", "changelog",
  "makefile", "gnumakefile", "dockerfile", "containerfile", "pkgbuild",
  ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".editorconfig", ".npmrc", ".yarnrc", ".prettierrc", ".eslintrc", ".babelrc",
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"
]);

/** Files rendered as resources rather than opened in the source editor. */
export function resourceFileKind(filePath: string): "image" | "pdf" | "binary" | "text" | "other" {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === "pdf") return "pdf";
  if (/^(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/.test(extension)) return "image";
  if (/^(?:zip|gz|bz2|xz|tar|rar|7z|zst|svgz|docx?|xlsx?|pptx?|od[tps]|mp[34]|wav|ogg|webm|mov|avi|flac|woff2?|ttf|otf|eot|pfb|pfa|tfm|vf|fmt|dvi|xdv|synctex|wasm|exe|bin|[ao]|so|dylib|dll|class|jar|sqlite3?|db|pyc|psd)$/.test(extension)) return "binary";
  if (textExtensions.has(extension) || textNames.has(name) || name === ".env" || name.startsWith(".env.")
    || name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return "text";
  return "other";
}

/** A path is only a candidate; contents must also be checked before decoding. */
export function isEditableTextFile(filePath: string, textContent?: boolean): boolean {
  return Boolean(filePath) && resourceFileKind(filePath) === "text" && textContent !== false;
}

/** Reject binary controls and invalid UTF-8, without replacing bytes on save.
 * A prefix may end inside a UTF-8 character, unlike a complete file.
 */
export function isTextContent(bytes: Uint8Array, partial = false): boolean {
  for (const byte of bytes) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) return false;
    if (byte === 127) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
    return true;
  } catch { return false; }
}
