import { afterEach, describe, expect, it, vi } from "vitest";
import { lintChktex, mapChktexLints } from "../src/client/chktex";
import { parseChktexOutput } from "../src/server/chktex";

describe("ChkTeX diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a page-local client id and an increasing sequence with every check", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json({ issues: [] }));
    vi.stubGlobal("fetch", fetch);
    await lintChktex("project", "main.tex", "First source.");
    await lintChktex("project", "main.tex", "Second source.");
    const [first, second] = fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(first).toMatchObject({ path: "main.tex", source: "First source.", clientId: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i), sequence: expect.any(Number) });
    expect(first.sequence).toBeGreaterThan(0);
    expect(second).toMatchObject({ path: "main.tex", source: "Second source.", clientId: first.clientId, sequence: first.sequence + 1 });
  });

  it("parses the stable machine-readable output while preserving pipes in messages", () => {
    expect(parseChktexOutput("stdin|3|11|2|8|Wrong length of dash | use an en dash.\n")).toEqual([{
      line: 3, column: 11, length: 2, number: 8, message: "Wrong length of dash | use an en dash."
    }]);
  });

  it("maps one-based line and scalar-column coordinates to editor offsets", () => {
    const source = "第一行\nSome -- text.\n";
    const issues = mapChktexLints(source, [{ line: 2, column: 6, length: 2, number: 8, message: "Use an en dash." }]);
    expect(issues).toMatchObject([{ from: 9, to: 11, word: "--", kind: "latex", message: "ChkTeX 8: Use an en dash." }]);
    const unicodeSource = "第一行\n中文文本 Some -- text.\n";
    expect(mapChktexLints(unicodeSource, [{ line: 2, column: 19, length: 2, number: 8, message: "Use an en dash." }])[0])
      .toMatchObject({ from: 14, to: 16, word: "--" });
  });
});
