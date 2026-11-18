import { describe, expect, it } from "vitest";
import { relocateSyncTeXInputs } from "../src/server/synctex.js";

describe("SyncTeX input relocation", () => {
  it("matches Windows drive, directory case and slash variants without touching external inputs", () => {
    const inputs = [
      String.raw`Input:1:c:/TEXLITE DATA/Cache\Source/chapters\论文 one.tex`,
      String.raw`Input:2:C:\TexLite Data\Cache\source\main.tex`,
      "Input:3:./chapters/part.tex",
      "Input:4:c:/TEXLITE DATA/Cache/Source-copy/main.tex",
      "Input:5:D:/TexLite Data/Cache/Source/main.tex",
      String.raw`Input:6:C:\texlive\texmf-dist\tex\latex\base\article.cls`,
      String.raw`Output:C:\TexLite Data\Cache\source\main.pdf`
    ];
    const relocated = relocateSyncTeXInputs(
      `${inputs.join("\r\n")}\r\n`,
      String.raw`C:\TexLite Data\Cache\source`,
      String.raw`C:\TexLite Data\runs\123\source`,
      "win32"
    );
    expect(relocated).toBe([
      String.raw`Input:1:C:\TexLite Data\runs\123\source\chapters\论文 one.tex`,
      String.raw`Input:2:C:\TexLite Data\runs\123\source\main.tex`,
      ...inputs.slice(2), ""
    ].join("\r\n"));
  });

  it("uses case-sensitive POSIX paths and matches only descendants of the cache root", () => {
    const external = ["Input:2:/Cache/source/main.tex", "Input:3:/cache/source/../other.tex", "Input:4:/cache/source-old/main.tex"];
    const content = ["SyncTeX Version:1", "Input:1:/cache/source/main.tex", ...external].join("\n");
    expect(relocateSyncTeXInputs(content, "/cache/source", "/run/source", "linux"))
      .toBe(["SyncTeX Version:1", "Input:1:/run/source/main.tex", ...external].join("\n"));
  });
});
