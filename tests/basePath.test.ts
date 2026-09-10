import { describe, expect, it } from "vitest";
import { appPath, scopedStorageKey, stripAppBasePath } from "../src/client/basePath";
import { renderClientIndex } from "../src/server/app.js";
import { compilePdfUrl } from "../src/server/compileArtifacts.js";
import { basePathHref, normalizeBasePath, withBasePath, withoutBasePath } from "../src/shared/basePath.js";

describe("deployment base paths", () => {
  it("normalizes and composes safe path prefixes", () => {
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("/tools/texlite/")).toBe("/tools/texlite");
    expect(normalizeBasePath("texlite")).toBeNull();
    expect(normalizeBasePath("/tools/../texlite")).toBeNull();
    expect(normalizeBasePath("/tools//texlite")).toBeNull();
    expect(basePathHref("/tools/texlite")).toBe("/tools/texlite/");
    expect(withBasePath("/tools/texlite", "/api/config")).toBe("/tools/texlite/api/config");
    expect(withBasePath("/api", "/api/config")).toBe("/api/api/config");
    expect(withBasePath("/project", "/project/one")).toBe("/project/project/one");
    expect(withBasePath("/", "/api/config")).toBe("/api/config");
    expect(withoutBasePath("/tools/texlite", "/tools/texlite/project/one")).toBe("/project/one");
    expect(withoutBasePath("/tools/texlite", "/another/project/one")).toBeNull();
  });

  it("builds client URLs and browser storage keys without changing root compatibility", () => {
    expect(appPath("/api/config", "/tools/texlite")).toBe("/tools/texlite/api/config");
    expect(stripAppBasePath("/tools/texlite/project/one", "/tools/texlite")).toBe("/project/one");
    expect(scopedStorageKey("texlite:key", "/")).toBe("texlite:key");
    expect(scopedStorageKey("texlite:key", "/tools/texlite")).toBe("texlite:key:base=%2Ftools%2Ftexlite");
  });

  it("injects the runtime path into the SPA shell and generated PDF URLs", () => {
    const source = '<html><head><base href="/" /><meta name="texlite-base-path" content="/" /></head></html>';
    const rendered = renderClientIndex(source, "/tools/texlite");
    expect(rendered).toContain('<base href="/tools/texlite/" />');
    expect(rendered).toContain('<meta name="texlite-base-path" content="/tools/texlite" />');
    expect(compilePdfUrl({ basePath: "/tools/texlite" }, "project-1", "main.tex", "run-1"))
      .toBe("/tools/texlite/api/projects/project-1/pdf?mainFile=main.tex&run=run-1");
  });

  it("keeps the SPA shell idempotent when its runtime base is unchanged", () => {
    const source = '<html><head><base href="/" /><meta name="texlite-base-path" content="/" /></head></html>';
    const rendered = renderClientIndex(source, "/");
    expect(rendered).toBe(source);
    expect(renderClientIndex(rendered, "/")).toBe(source);
  });
});
