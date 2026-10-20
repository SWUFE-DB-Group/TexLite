import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompilerVersions } from "../src/client/workspace/CompilerVersions";
import i18n from "../src/client/i18n";

describe("compiler version disclosure", () => {
  it("initially shows only an explicit action, without a loading state or version list", () => {
    const html = renderToStaticMarkup(createElement(CompilerVersions));
    expect(html).toContain('<button type="button" class="compiler-versions-toggle">');
    expect(html).toContain(i18n.t("projectSettings.showSoftwareVersions") + "</button>");
    expect(html).not.toContain("<dl>");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain("pdfLaTeX");
  });
});
