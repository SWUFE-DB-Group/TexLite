import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config";
import { listProjectFilesAsync } from "../src/server/files";

let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("metadata-only file-tree refreshes", () => {
  it("never opens or reads file contents, including on repeated refreshes", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-file-list-"));
    const config = { projectsDir: root } as Config;
    const source = path.join(root, "project", "source");
    fs.mkdirSync(path.join(source, "data"), { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\n");
    fs.writeFileSync(path.join(source, "data", "large.csv"), "1,2,3\n".repeat(200_000));
    fs.writeFileSync(path.join(source, "unknown.custom"), Buffer.from([0, 255]));
    const open = vi.spyOn(fs.promises, "open");
    const read = vi.spyOn(fs.promises, "readFile");
    const readSync = vi.spyOn(fs, "readFileSync");
    for (let index = 0; index < 3; index++) {
      const files = await listProjectFilesAsync(config, "project");
      expect(files.map((file) => file.path)).toEqual(["data", "data/large.csv", "main.tex", "unknown.custom"]);
      expect(files.find((file) => file.path === "data/large.csv")).toMatchObject({ type: "file", size: 1_200_000 });
    }
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
  });

  it("returns fresh size and modification metadata after file changes", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-file-list-"));
    const source = path.join(root, "project", "source");
    fs.mkdirSync(source, { recursive: true });
    const target = path.join(source, "notes.txt");
    fs.writeFileSync(target, "old");
    const config = { projectsDir: root } as Config;
    expect((await listProjectFilesAsync(config, "project"))[0]).toMatchObject({ size: 3 });
    fs.writeFileSync(target, "new contents");
    const [entry] = await listProjectFilesAsync(config, "project");
    expect(entry).toMatchObject({ path: "notes.txt", size: 12, mtimeMs: fs.statSync(target).mtimeMs });
  });
});
