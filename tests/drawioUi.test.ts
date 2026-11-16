// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DrawioEditor, { DRAWIO_ORIGIN, decodeDrawioSvg, type DrawioEditorHandle } from "../src/client/workspace/DrawioEditor";
import { api, ApiError } from "../src/client/api";
import { EMPTY_DRAWIO } from "../src/shared/drawio";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let root: Root, host: HTMLDivElement;
let frame: HTMLIFrameElement;
const changed = EMPTY_DRAWIO.replace("Page-1", "Changed");
const onClose = vi.fn(), onChanged = vi.fn();
const editor = createRef<DrawioEditorHandle>();
const send = (data: object, origin = DRAWIO_ORIGIN, source: Window | null = frame.contentWindow) => act(async () => {
  window.dispatchEvent(new MessageEvent("message", { origin, source, data: JSON.stringify(data) }));
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
const mount = async (readOnly = false, pdfRevision: string | null = null) => {
  vi.mocked(api).mockResolvedValueOnce({ content: EMPTY_DRAWIO, revision: "r1", pdfRevision });
  await act(async () => root.render(createElement(DrawioEditor, { ref: editor, projectId: "p1", path: "figures/diagram.drawio", readOnly, onClose, onChanged })));
  frame = document.querySelector("iframe")!;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await send({ event: "init" }); await send({ event: "load" });
};
const sent = () => vi.mocked(frame.contentWindow!.postMessage).mock.calls.map(([message]) => JSON.parse(message as string));
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  // A local empty frame supplies postMessage endpoints without loading the
  // external editor. Protocol events below are supplied explicitly.
  const attribute = HTMLIFrameElement.prototype.getAttribute;
  vi.spyOn(HTMLIFrameElement.prototype, "getAttribute").mockImplementation(function (this: HTMLIFrameElement, name: string) {
    return name === "srcdoc" ? "" : attribute.call(this, name);
  });
  vi.mocked(api).mockReset(); onClose.mockReset(); onChanged.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("embedded draw.io editing", () => {
  it("accepts only the iframe's exact origin/source, and configures plain text without exposing project URLs", async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".drawio-editor iframe")).toBe(frame);
    expect(vi.mocked(api).mock.calls[0][0]).toBe("/api/projects/p1/drawio?path=figures%2Fdiagram.drawio");
    expect(frame.src).not.toContain("p1"); expect(frame.src).not.toContain(EMPTY_DRAWIO);
    expect(sent()[0]).toMatchObject({ action: "load", xml: EMPTY_DRAWIO, autosave: 1 });
    await send({ event: "autosave", xml: changed }, "https://evil.test");
    await send({ event: "autosave", xml: changed }, DRAWIO_ORIGIN, window);
    expect(button("Save").disabled).toBe(true);
    await send({ event: "configure" });
    expect(sent().at(-1)).toMatchObject({ action: "configure", config: { defaultVertexStyle: { html: "0" }, suppressNewWindows: true } });
  });

  it("retrieves the latest XML and saves once with a revision; changes during save remain dirty", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    expect(button("Save").disabled).toBe(false);
    let resolve!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => button("Save").click());
    const request = sent().at(-1); expect(request).toMatchObject({ action: "export", format: "xml" });
    // A forged/stale response cannot commit changes.
    await send({ event: "export", format: "xml", xml: changed, message: { requestId: 999 } });
    expect(api).toHaveBeenCalledTimes(1);
    const saving = send({ event: "export", format: "xml", xml: changed, message: request });
    await saving;
    await send({ event: "export", format: "xml", xml: changed, message: request });
    expect(api).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toEqual({ path: "figures/diagram.drawio", content: changed, revision: "r1" });
    const newer = changed.replace("Changed", "Newer"); await send({ event: "autosave", xml: newer });
    await act(async () => resolve({ revision: "r2" }));
    expect(button("Saved").disabled).toBe(false);
    expect(document.body.textContent).toContain("Unsaved changes");
    await act(async () => document.querySelector<HTMLButtonElement>(".drawio-close")!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard unsaved diagram changes?");
  });

  it("requires confirmation before replacing a PDF, saves source first, and preserves errors for retry", async () => {
    await mount(false, "pdf-r1");
    await act(async () => button("Export PDF").click());
    expect(sent().at(-1).action).toBe("load");
    await act(async () => button("Replace and export").click());
    const request = sent().at(-1); expect(request).toMatchObject({ format: "svg", embedImages: true, currentPage: true, theme: "light" });
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" }).mockRejectedValueOnce(new ApiError("Install a browser", 503, "DRAWIO_BROWSER_UNAVAILABLE"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>';
    await send({ event: "export", format: "svg", xml: changed, data: `data:image/svg+xml,${encodeURIComponent(svg)}`, message: request });
    const calls = vi.mocked(api).mock.calls;
    expect(calls[1][1]?.method).toBe("PUT"); expect(calls[2][1]?.method).toBe("POST");
    expect(JSON.parse(calls[2][1]!.body as string)).toEqual({ path: "figures/diagram.drawio", svg, revision: "r2", pdfRevision: "pdf-r1" });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Install a browser");
    expect(button("Export PDF").disabled).toBe(false);
  });

  it("does not expose save/export to readers or honor unsolicited export messages", async () => {
    await mount(true);
    expect(sent()[0]).toMatchObject({ readOnly: true, autosave: 0 });
    expect(button("Save")).toBeUndefined(); expect(button("Export PDF")).toBeUndefined();
    await send({ event: "export", format: "svg", xml: changed, message: { requestId: 1 } });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("checks current XML before closing even if a recent change has not emitted autosave yet", async () => {
    await mount();
    await act(async () => document.querySelector<HTMLButtonElement>(".drawio-close")!.click());
    expect(onClose).not.toHaveBeenCalled();
    const request = sent().at(-1); expect(request.format).toBe("xml");
    await send({ event: "export", format: "xml", xml: changed, message: request });
    expect(onClose).not.toHaveBeenCalled(); expect(api).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Discard unsaved diagram changes?");
  });

  it("cancels pending writes on close/unmount and ignores their late results", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    await act(async () => button("Save").click());
    let resolve!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    const signal = vi.mocked(api).mock.calls[1][1]?.signal;
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ revision: "late" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("guards external file navigation with cancel/discard decisions without closing the editor itself", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    let decision!: Promise<boolean>;
    await act(async () => { decision = editor.current!.confirmClose(); });
    await act(async () => button("Cancel").click());
    await expect(decision).resolves.toBe(false);
    expect(host.querySelector("iframe")).toBe(frame);
    await act(async () => { decision = editor.current!.confirmClose(); });
    await act(async () => button("Discard").click());
    await expect(decision).resolves.toBe(true);
    expect(onClose).not.toHaveBeenCalled(); // The caller now owns switching files.
  });

  it("decodes Unicode SVG exports without fetching arbitrary URLs", () => {
    const svg = '<svg><text>中文</text></svg>';
    const bytes = new TextEncoder().encode(svg);
    expect(decodeDrawioSvg(`data:image/svg+xml;base64,${btoa(String.fromCharCode(...bytes))}`)).toBe(svg);
    for (const value of ["https://evil.test", "data:text/html,<script/>", "data:image/svg+xml,%zz"]) expect(() => decodeDrawioSvg(value)).toThrow();
  });
});
