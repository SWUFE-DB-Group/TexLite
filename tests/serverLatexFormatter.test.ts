import { describe, expect, it } from "vitest";
import { LatexFormatterService } from "../src/server/latexFormatter.js";

describe("host LaTeX formatter", () => {
  it("reports an actionable error when tex-fmt is not installed", async () => {
    const service = new LatexFormatterService("__texlite_missing_tex_fmt__");
    await expect(service.format("\\section{Title}\n", process.cwd())).rejects.toMatchObject({
      code: "FORMATTER_UNAVAILABLE",
      statusCode: 503
    });
  });
});
