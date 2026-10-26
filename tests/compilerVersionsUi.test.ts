// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { CompilerVersions } from "../src/client/workspace/CompilerVersions";
import i18n from "../src/client/i18n";
import type { CompilerVersionsResponse } from "../src/shared/compilerVersions";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => { root.render(createElement(CompilerVersions)); });
const showVersions = () => act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); });
const displayedVersions = () => Object.fromEntries([...host.querySelectorAll("dt")]
  .map((name) => [name.textContent, name.nextElementSibling?.textContent]));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("compiler version disclosure", () => {
  it("queries only after a click, shows loading feedback and renders known and unknown versions", async () => {
    let finish!: (value: CompilerVersionsResponse) => void;
    vi.mocked(api).mockReturnValue(new Promise<CompilerVersionsResponse>((resolve) => { finish = resolve; }));
    await render();
    expect(host.querySelector("button")?.textContent).toBe(i18n.t("projectSettings.showSoftwareVersions"));
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(api).not.toHaveBeenCalled();

    await showVersions();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/compiler/versions", { signal: expect.any(AbortSignal) });
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await render();
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => finish({ tools: [
      { id: "texlive", version: "2026" }, { id: "pdflatex", version: "1.40.29" }, { id: "xelatex", version: null }
    ] }));
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(displayedVersions()).toMatchObject({
      "TeX Live": "2026", pdfLaTeX: "1.40.29",
      XeLaTeX: i18n.t("projectSettings.unknownVersion"), latexmk: i18n.t("projectSettings.unknownVersion")
    });
  });

  it("finishes loading and shows unknown versions when the query fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Software probe unavailable"));
    await render();
    await showVersions();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(displayedVersions()).toMatchObject({
      "TeX Live": i18n.t("projectSettings.unknownVersion"),
      pdfLaTeX: i18n.t("projectSettings.unknownVersion"), latexmk: i18n.t("projectSettings.unknownVersion")
    });
  });

  it("cancels the query on unmount without letting a late result open a remounted disclosure", async () => {
    let finish!: (value: CompilerVersionsResponse) => void;
    vi.mocked(api).mockReturnValue(new Promise<CompilerVersionsResponse>((resolve) => { finish = resolve; }));
    await render();
    await showVersions();
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);

    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    await render();
    await act(async () => finish({ tools: [{ id: "texlive", version: "2026" }] }));
    expect(api).toHaveBeenCalledTimes(1);
    expect(host.querySelector("button")?.textContent).toBe(i18n.t("projectSettings.showSoftwareVersions"));
    expect(displayedVersions()).toEqual({});
  });
});
