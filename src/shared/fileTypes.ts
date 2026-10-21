export const MAX_TEXT_EDITOR_BYTES = 5 * 1024 * 1024;

/** Files rendered as resources rather than opened in the source editor. */
export function resourceFileKind(filePath: string): "image" | "pdf" | "binary" | "text" {
  const name = filePath.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === "pdf") return "pdf";
  if (/^(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/.test(extension)) return "image";
  if (/^(?:zip|gz|bz2|xz|tar|rar|7z|zst|docx?|xlsx?|pptx?|od[tps]|mp[34]|wav|ogg|webm|mov|avi|flac|woff2?|ttf|otf|eot|pfb|pfa|tfm|vf|fmt|dvi|xdv|synctex|wasm|exe|bin|[ao]|so|dylib|dll|class|jar|sqlite3?|db|pyc|psd)$/.test(extension)) return "binary";
  return "text";
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
