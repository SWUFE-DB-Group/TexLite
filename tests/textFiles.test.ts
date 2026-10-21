import { describe, expect, it } from "vitest";
import { isEditableTextFile, isTextContent, MAX_TEXT_EDITOR_BYTES, resourceFileKind } from "../src/shared/fileTypes";
import { fileOpenKind } from "../src/client/workspace/useProjectFiles";

const encode = (source: string) => new TextEncoder().encode(source);

describe("project text file classification", () => {
  it.each(["config.json", "config.YAML", "data.txt", "run.sh", "data.dat", ".gitignore", "LICENSE", "custom.unusual", ".latexmkrc"])("permits UTF-8 text candidates: %s", (file) => {
    expect(isEditableTextFile(file)).toBe(true);
    expect(fileOpenKind({ path: file, type: "file", size: 100, textContent: true }, MAX_TEXT_EDITOR_BYTES)).toBe("editor");
  });

  it.each(["figure.png", "figure.JPG", "figure.svg", "paper.PDF", "archive.zip", "font.otf", "library.so", "data.sqlite"])("does not edit known resources: %s", (file) => {
    expect(isEditableTextFile(file)).toBe(false);
    expect(fileOpenKind({ path: file, type: "file", size: 100 }, MAX_TEXT_EDITOR_BYTES)).not.toBe("editor");
  });

  it("retains image/PDF previews and rejects unknown binary content", () => {
    expect(resourceFileKind("figure.svg")).toBe("image");
    expect(resourceFileKind("paper.pdf")).toBe("pdf");
    expect(fileOpenKind({ path: "data.unknown", type: "file", size: 3, textContent: false }, MAX_TEXT_EDITOR_BYTES)).toBe("unsupported");
    expect(isEditableTextFile("data.txt", false)).toBe(false);
  });

  it("blocks oversized text and resources with the appropriate separate limits", () => {
    expect(fileOpenKind({ path: "large.json", type: "file", size: MAX_TEXT_EDITOR_BYTES }, MAX_TEXT_EDITOR_BYTES)).toBe("editor");
    expect(fileOpenKind({ path: "large.json", type: "file", size: MAX_TEXT_EDITOR_BYTES + 1 }, MAX_TEXT_EDITOR_BYTES)).toBe("large");
    expect(fileOpenKind({ path: "paper.pdf", type: "file", size: 8 * 1024 * 1024 }, MAX_TEXT_EDITOR_BYTES)).toBe("pdf");
    expect(fileOpenKind({ path: "paper.pdf", type: "file", size: 11 * 1024 * 1024 }, MAX_TEXT_EDITOR_BYTES)).toBe("large");
    expect(fileOpenKind({ path: "small.txt", type: "file", size: 1025 }, 1024)).toBe("large");
  });

  it("prioritizes unsupported binary content over the size limit", () => {
    const size = 20 * 1024 * 1024;
    expect(fileOpenKind({ path: "archive.zip", type: "file", size }, MAX_TEXT_EDITOR_BYTES)).toBe("unsupported");
    expect(fileOpenKind({ path: "data.unknown", type: "file", size, textContent: false }, MAX_TEXT_EDITOR_BYTES)).toBe("unsupported");
    expect(fileOpenKind({ path: "pretend.txt", type: "file", size, textContent: false }, MAX_TEXT_EDITOR_BYTES)).toBe("unsupported");
    expect(fileOpenKind({ path: "figure.png", type: "file", size }, MAX_TEXT_EDITOR_BYTES)).toBe("large");
    expect(fileOpenKind({ path: "paper.pdf", type: "file", size }, MAX_TEXT_EDITOR_BYTES)).toBe("large");
  });

  it("accepts Unicode and text whitespace without accepting corrupt binary bytes", () => {
    for (const text of ["", "你好 — café 😊", "\uFEFF# config\nkey:\tvalue\r\n\f"]) expect(isTextContent(encode(text))).toBe(true);
    for (const bytes of [Uint8Array.of(0), Uint8Array.of(255, 254), encode("text\0hidden"), Uint8Array.of(27, 91), Uint8Array.of(195, 40)]) {
      expect(isTextContent(bytes)).toBe(false);
    }
    const chinese = encode("中文");
    expect(isTextContent(chinese.subarray(0, 4), true)).toBe(true);
    expect(isTextContent(chinese.subarray(0, 4))).toBe(false);
  });
});
