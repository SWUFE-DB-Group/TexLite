import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractProjectZip } from "../src/server/zip.js";
import { writeProjectArchive } from "../src/server/archive.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { sourceRoot } from "../src/server/files.js";

const MAIN = "\\documentclass{article}\n\\begin{document}你好\\end{document}\n";
const MB = 1024 * 1024;

describe("project ZIP import and export", () => {
  let root: string;
  let config: Config;
  let destination: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-zip-"));
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ storage: { dataDir: root } }));
    config = loadConfig(configPath);
    destination = path.join(root, "extracted");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("extracts stored and deflated entries, strips a common root and preserves UTF-8 names", async () => {
    const image = Buffer.from([0, 255, 128, 1]);
    const zip = makeZip([
      { name: "论文/", content: "" },
      { name: "论文/主文档.TEX", content: MAIN, deflate: true },
      { name: "论文/图表/示例.png", content: image },
      { name: "论文/refs.bib", content: "@misc{paper,title={研究}}", deflate: true },
      { name: "论文/.latexmkrc", content: "$silent = 1;" },
      { name: "论文/empty/", content: "" },
      { name: "论文/.DS_Store", content: "metadata" },
      { name: "论文/__MACOSX/._file", content: "metadata" }
    ]);
    const result = await extractProjectZip(zip, destination, MB);
    expect(result).toEqual({
      mainFile: "主文档.TEX", files: ["主文档.TEX", "图表/示例.png", "refs.bib", ".latexmkrc"]
    });
    expect(fs.readFileSync(path.join(destination, "主文档.TEX"), "utf8")).toBe(MAIN);
    expect(fs.readFileSync(path.join(destination, "图表/示例.png"))).toEqual(image);
    expect(fs.statSync(path.join(destination, "empty")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(destination, "论文"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "__MACOSX"))).toBe(false);
  });

  it.each(["../main.tex", "/main.tex", "C:/main.tex", "folder/../../main.tex", "folder/../main.tex", "folder\\main.tex", "main\0.tex", ".git/config"])(
    "rejects unsafe entry paths before writing files: %s", async (name) => {
      await expect(extractProjectZip(makeZip([{ name, content: MAIN }]), destination, MB))
        .rejects.toMatchObject({ code: "ZIP_INVALID_PATH" });
      expect(fs.existsSync(destination)).toBe(false);
    }
  );

  it.each([
    ["main.tex", "main.tex"], ["main.tex", "./main.tex"], ["data", "data/"], ["a/b", "a//b"]
  ])("rejects duplicate or colliding names %s and %s before writing files", async (first, second) => {
    const zip = makeZip([{ name: first, content: MAIN }, { name: second, content: "" }]);
    await expect(extractProjectZip(zip, destination, MB)).rejects.toMatchObject({ code: "ZIP_DUPLICATE_ENTRY" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects Unix symlink entries", async () => {
    const zip = makeZip([{ name: "main.tex", content: "/etc/passwd", mode: 0o120777 }]);
    await expect(extractProjectZip(zip, destination, MB)).rejects.toMatchObject({ code: "ZIP_SYMLINK_FORBIDDEN" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("enforces entry count and declared file/total size limits before extraction", async () => {
    const entries = Array.from({ length: 1_001 }, (_, index) => ({ name: `${index}.tex`, content: "" }));
    await expect(extractProjectZip(makeZip(entries), destination, MB)).rejects.toMatchObject({ code: "ZIP_TOO_MANY_ENTRIES" });
    await expect(extractProjectZip(makeZip([{ name: "main.tex", content: "", declaredSize: MB + 1 }]), destination, MB))
      .rejects.toMatchObject({ code: "ZIP_ENTRY_TOO_LARGE" });
    const total = ["a.tex", "b.tex", "c.tex"].map((name) => ({ name, content: "", declaredSize: 80 * MB }));
    await expect(extractProjectZip(makeZip(total), destination, 100 * MB)).rejects.toMatchObject({ code: "ZIP_TOTAL_TOO_LARGE" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each([
    { name: "main.tex", content: MAIN, crc: 1, deflate: true },
    { name: "main.tex", content: MAIN, declaredSize: 1, deflate: true },
    { name: "main.tex", content: MAIN, flags: 0x801 },
    { name: "main.tex", content: MAIN, method: 99 }
  ])("rejects corrupt sizes/checksums, encryption and unsupported compression without hanging: %j", async (entry) => {
    await expect(extractProjectZip(makeZip([entry]), destination, MB))
      .rejects.toMatchObject({ code: "ZIP_ENTRY_READ_FAILED" });
  });

  it("reports malformed archives and missing main documents", async () => {
    await expect(extractProjectZip(Buffer.from("not a zip"), destination, MB)).rejects.toMatchObject({ code: "ZIP_READ_FAILED" });
    await expect(extractProjectZip(makeZip([{ name: "one.tex", content: "fragment" }, { name: "two.tex", content: "fragment" }]), destination, MB))
      .rejects.toMatchObject({ code: "ZIP_MAIN_DOCUMENT_NOT_FOUND" });
  });

  it("selects a documentclass candidate when there are multiple TeX files", async () => {
    const result = await extractProjectZip(makeZip([
      { name: "fragment.tex", content: "\\section{Part}" }, { name: "main.tex", content: MAIN }
    ]), destination, MB);
    expect(result.mainFile).toBe("main.tex");
  });

  it("reads ZIP64 entries and data descriptors", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, zip64: true });
    await writer.add("main.tex", new TextReader(MAIN), { zip64: true, dataDescriptor: true });
    const result = await extractProjectZip(Buffer.from(await writer.close()), destination, MB);
    expect(result.mainFile).toBe("main.tex");
    expect(fs.readFileSync(path.join(destination, "main.tex"), "utf8")).toBe(MAIN);
  });

  it("exports text, binary, Unicode names and empty folders, excluding Git, with independently readable bytes", async () => {
    const source = sourceRoot(config, "project");
    fs.mkdirSync(path.join(source, "图表"), { recursive: true });
    fs.mkdirSync(path.join(source, "empty"));
    fs.mkdirSync(path.join(source, ".git"));
    fs.writeFileSync(path.join(source, ".git", "config"), "secret");
    fs.writeFileSync(path.join(source, "主文档.tex"), MAIN);
    fs.writeFileSync(path.join(source, ".latexmkrc"), "$silent = 1;");
    const binary = Buffer.from([0, 1, 128, 255]);
    fs.writeFileSync(path.join(source, "图表", "figure.png"), binary);
    const archive = path.join(root, "project.zip");
    await writeProjectArchive(config, "project", archive);
    const exported = readZip(fs.readFileSync(archive));
    expect([...exported.keys()].sort()).toEqual([".latexmkrc", "empty/", "主文档.tex", "图表/figure.png"]);
    expect(exported.get("主文档.tex")?.toString()).toBe(MAIN);
    expect(exported.get("图表/figure.png")).toEqual(binary);
    const imported = await extractProjectZip(fs.readFileSync(archive), destination, MB);
    expect(imported.mainFile).toBe("主文档.tex");
    expect(fs.readFileSync(path.join(destination, "图表", "figure.png"))).toEqual(binary);
  });

  it("rejects project symlinks and failed output streams", async () => {
    const source = sourceRoot(config, "project");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), MAIN);
    await expect(writeProjectArchive(config, "project", path.join(root, "absent", "out.zip")))
      .rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(root, "config.json"), path.join(source, "outside.tex"));
      await expect(writeProjectArchive(config, "project", path.join(root, "unsafe.zip"))).rejects.toThrow(/symbolic/i);
    }
  });
});

interface FixtureEntry {
  name: string;
  content: string | Buffer;
  deflate?: boolean;
  declaredSize?: number;
  mode?: number;
  crc?: number;
  flags?: number;
  method?: number;
}

/** Independent ZIP fixture builder; does not use the library being tested. */
function makeZip(entries: FixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const compressed = entry.deflate ? deflateRawSync(content) : content;
    const checksum = entry.crc ?? crc32(content);
    const size = entry.declaredSize ?? content.length;
    const flags = entry.flags ?? 0x800;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0o40700 : 0o100600)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralParts.reduce((total, part) => total + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/** Read these small export fixtures using Node zlib and central-directory fields. */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const end = buffer.length - 22;
  expect(buffer.readUInt32LE(end)).toBe(0x06054b50);
  const entries = new Map<string, Buffer>();
  let cursor = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index++) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const offset = buffer.readUInt32LE(cursor + 42);
    const dataOffset = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const content = buffer.readUInt16LE(cursor + 10) === 8 ? inflateRawSync(compressed) : compressed;
    expect(crc32(content)).toBe(buffer.readUInt32LE(cursor + 16));
    expect(content.length).toBe(buffer.readUInt32LE(cursor + 24));
    entries.set(name, content);
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  return entries;
}
