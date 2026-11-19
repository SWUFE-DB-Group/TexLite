// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DrawioEditor, { decodeDrawioSvg, type DrawioEditorHandle } from "../src/client/workspace/DrawioEditor";
import { api, ApiError } from "../src/client/api";
import { DRAWIO_ORIGIN, EMPTY_DRAWIO, type DrawioDocument } from "../src/shared/drawio";
import { renderDrawioSelection } from "../src/client/workspace/drawioSelectionExport";
import i18n from "../src/client/i18n";
import { deflateRawSync } from "node:zlib";
import { sameDrawioContent } from "../src/client/workspace/drawioContent";
import * as drawioContent from "../src/client/workspace/drawioContent";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
const { lease } = vi.hoisted(() => ({ lease: {
  state: { status: "owned", token: "lease-1", name: "" } as { status: string; token: string; name: string; revision?: string },
  current: { current: { status: "owned", token: "lease-1", name: "" } as { status: string; token: string; name: string; revision?: string } }, retry: vi.fn()
} }));
vi.mock("../src/client/workspace/useDrawioLock", () => ({ useDrawioLock: () => lease }));
vi.mock("../src/client/workspace/drawioSelectionExport", async (original) => ({
  ...await original<typeof import("../src/client/workspace/drawioSelectionExport")>(), renderDrawioSelection: vi.fn()
}));
let root: Root, host: HTMLDivElement;
let frame: HTMLIFrameElement;
const changed = EMPTY_DRAWIO.replace("Page-1", "Changed");
const compressed = (xml: string) => xml.replace(/<diagram([^>]*)>([\s\S]*?)<\/diagram>/g, (_match, attributes, model) =>
  `<diagram${attributes}>${deflateRawSync(Buffer.from(encodeURIComponent(model.trim()))).toString("base64")}</diagram>`);
const onClose = vi.fn(), onChanged = vi.fn();
const editor = createRef<DrawioEditorHandle>();
// Mimic the workspace's file navigation through the imperative handle.
const requestClose = () => act(async () => {
  void editor.current!.confirmClose().then((confirmed) => { if (confirmed) onClose(); });
});
const send = (data: object, origin = DRAWIO_ORIGIN, source: Window | null = frame.contentWindow) => act(async () => {
  window.dispatchEvent(new MessageEvent("message", { origin, source, data: JSON.stringify(data) }));
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
const closeButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const saveShortcut = async (mac = false) => {
  const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: !mac, metaKey: mac, cancelable: true, bubbles: true });
  await act(async () => window.dispatchEvent(event));
  return event.defaultPrevented;
};
const mount = async (readOnly = false, pdfRevision: string | null = null) => {
  vi.mocked(api).mockResolvedValueOnce({ content: EMPTY_DRAWIO, revision: "r1", pdfRevision });
  await act(async () => root.render(createElement(DrawioEditor, { ref: editor, projectId: "p1", path: "figures/diagram.drawio", readOnly, onChanged, onClose })));
  frame = document.querySelector("iframe")!;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await send({ event: "init" }); await send({ event: "load" });
};
const sent = () => vi.mocked(frame.contentWindow!.postMessage).mock.calls.map(([message]) => JSON.parse(message as string));
const configureExport = async (scope: "page" | "selection", margin = "0") => {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
  await send({ event: "export", format: "json", data: { pages: [{ cells: [{ id: "a" }] }] }, message: sent().at(-1) });
  await act(async () => document.querySelector<HTMLInputElement>(`.drawio-export-options input[value="${scope}"]`)!.click());
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, margin);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  // A local empty frame supplies postMessage endpoints without loading the
  // external editor. Protocol events below are supplied explicitly.
  const attribute = HTMLIFrameElement.prototype.getAttribute;
  vi.spyOn(HTMLIFrameElement.prototype, "getAttribute").mockImplementation(function (this: HTMLIFrameElement, name: string) {
    return name === "srcdoc" ? "" : attribute.call(this, name);
  });
  vi.mocked(api).mockReset(); onClose.mockReset(); onChanged.mockReset();
  vi.mocked(renderDrawioSelection).mockReset();
  lease.state = { status: "owned", token: "lease-1", name: "" }; lease.current.current = lease.state; lease.retry.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("embedded draw.io editing", () => {
  it("shows the file name in TexLite without adding a title to the embedded menu", async () => {
    await mount();
    expect(host.querySelector(".drawio-toolbar")?.textContent).toContain("figures/diagram.drawio");
    expect(sent().find(({ action }) => action === "load")).not.toHaveProperty("title");
  });

  it("shows the check only for saved diagrams and opens draw.io help below its button", async () => {
    await mount();
    const status = host.querySelector(".drawio-status")!;
    expect(status.textContent).toBe("Saved");
    expect(status.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await send({ event: "autosave", xml: changed });
    expect(status.textContent).toBe("Saving…");
    expect(status.querySelector("svg")).toBeNull();
    const help = host.querySelector<HTMLButtonElement>(".drawio-help button")!;
    await act(async () => help.click());
    const content = document.querySelector(".info-popover-content");
    expect(content?.getAttribute("data-side")).toBe("bottom");
    expect(content?.textContent).toBe(i18n.t("drawio.help"));
  });

  it.each([
    ["source", "lock", "init"], ["source", "init", "lock"],
    ["lock", "source", "init"], ["lock", "init", "source"],
    ["init", "source", "lock"], ["init", "lock", "source"]
  ])("loads one editable graph when startup completes in order %s → %s → %s", async (...order) => {
    lease.state = { status: "connecting", token: "", name: "" }; lease.current.current = lease.state;
    let resolve!: (document: DrawioDocument) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise<DrawioDocument>((done) => { resolve = done; }));
    const rerender = () => act(async () => root.render(createElement(DrawioEditor, {
      projectId: "p1", path: "figures/diagram.drawio", readOnly: false, onChanged, onClose
    })));
    await rerender();
    frame = document.querySelector("iframe")!;
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    for (const [index, phase] of order.entries()) {
      if (phase === "source") await act(async () => resolve({ content: EMPTY_DRAWIO, revision: "r1", pdfRevision: null }));
      if (phase === "lock") {
        lease.state = { status: "owned", token: "lease-1", name: "", revision: "r1" }; lease.current.current = lease.state;
        await rerender();
      }
      if (phase === "init") await send({ event: "init" });
      expect(sent()).toHaveLength(index === 2 ? 1 : 0);
    }
    expect(sent()[0]).toMatchObject({ action: "load", xml: EMPTY_DRAWIO, readOnly: false, autosave: 1 });
    await send({ event: "load" });
    expect(sent()).toHaveLength(1);
    expect(button("Export PDF").disabled).toBe(false);
  });

  it("waits for a pending read-only load before upgrading it to editable", async () => {
    lease.state = { status: "busy", token: "", name: "Writer" }; lease.current.current = lease.state;
    vi.mocked(api).mockResolvedValueOnce({ content: EMPTY_DRAWIO, revision: "r1", pdfRevision: null });
    const rerender = () => act(async () => root.render(createElement(DrawioEditor, {
      projectId: "p1", path: "figures/diagram.drawio", readOnly: false, onChanged, onClose
    })));
    await rerender();
    frame = document.querySelector("iframe")!;
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await send({ event: "init" });
    expect(sent()).toEqual([expect.objectContaining({ readOnly: true })]);
    lease.state = { status: "owned", token: "lease-2", name: "", revision: "r1" }; lease.current.current = lease.state;
    await rerender();
    expect(sent()).toHaveLength(1);
    await send({ event: "load" });
    expect(sent()).toEqual([expect.objectContaining({ readOnly: true }), expect.objectContaining({ readOnly: false })]);
    await send({ event: "load" });
    expect(sent()).toHaveLength(2);
  });

  it("does not bootstrap stale source while the initial lease revision is being reconciled", async () => {
    lease.state = { status: "owned", token: "lease-1", name: "", revision: "r2" }; lease.current.current = lease.state;
    let refresh!: (document: DrawioDocument) => void;
    vi.mocked(api).mockResolvedValueOnce({ content: EMPTY_DRAWIO, revision: "r1", pdfRevision: null })
      .mockReturnValueOnce(new Promise<DrawioDocument>((resolve) => { refresh = resolve; }));
    await act(async () => root.render(createElement(DrawioEditor, {
      projectId: "p1", path: "figures/diagram.drawio", readOnly: false, onChanged, onClose
    })));
    frame = document.querySelector("iframe")!;
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await send({ event: "init" });
    expect(sent()).toHaveLength(0);
    await act(async () => refresh({ content: changed, revision: "r2", pdfRevision: null }));
    expect(sent()).toEqual([expect.objectContaining({ action: "load", xml: changed, readOnly: false })]);
  });

  it("accepts only the iframe's exact origin/source, and configures plain text without exposing project URLs", async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".drawio-editor iframe")).toBe(frame);
    expect(vi.mocked(api).mock.calls[0][0]).toBe("/api/projects/p1/drawio?path=figures%2Fdiagram.drawio");
    expect(frame.src).not.toContain("p1"); expect(frame.src).not.toContain(EMPTY_DRAWIO);
    expect(sent()).toEqual([expect.objectContaining({ action: "load", xml: EMPTY_DRAWIO, readOnly: false, autosave: 1 })]);
    await send({ event: "autosave", xml: changed }, "https://evil.test");
    await send({ event: "autosave", xml: changed }, DRAWIO_ORIGIN, window);
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saved");
    await send({ event: "configure" });
    expect(sent().at(-1)).toMatchObject({ action: "configure", config: { defaultVertexStyle: { html: "0" }, suppressNewWindows: true,
      hideMenuItems: ["exportPdf"],
      passThroughKeys: [{ key: "s", ctrl: true, shift: false, alt: false, command: "save" }] } });
  });

  it("enables math for new diagrams without forcing it in the iframe", async () => {
    await mount();
    const { xml } = sent()[0];
    const diagram = new DOMParser().parseFromString(xml, "text/xml");
    expect(diagram.querySelector("mxGraphModel")?.getAttribute("math")).toBe("1");
    expect(new URL(frame.src).searchParams.has("math")).toBe(false);
  });

  it("debounces consecutive edits and serializes newer edits behind an in-flight save", async () => {
    vi.useFakeTimers();
    await mount(); await send({ event: "autosave", xml: changed });
    expect(button("Save")).toBeUndefined();
    const latest = changed.replace("Changed", "Latest");
    await act(async () => vi.advanceTimersByTimeAsync(900));
    await send({ event: "autosave", xml: latest });
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(sent().at(-1).action).toBe("load");
    let resolve!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const request = sent().at(-1); expect(request).toMatchObject({ action: "export", format: "xml" });
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saving…");
    // A forged/stale response cannot commit changes.
    await send({ event: "export", format: "xml", xml: latest, message: { requestId: 999 } });
    expect(api).toHaveBeenCalledTimes(1);
    await send({ event: "export", format: "xml", xml: latest, message: request });
    await send({ event: "export", format: "xml", xml: latest, message: request });
    expect(api).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toMatchObject({ content: latest, revision: "r1", lockToken: "lease-1" });
    const newer = changed.replace("Changed", "Newer"); await send({ event: "autosave", xml: newer });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(sent().at(-1)).toEqual(request);
    await act(async () => resolve({ revision: "r2" }));
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saving…");
    expect(sent().at(-1)).toEqual({ action: "status", message: "", modified: true });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const next = sent().at(-1);
    expect(next.requestId).not.toBe(request.requestId);
    vi.mocked(api).mockResolvedValueOnce({ revision: "r3" });
    await send({ event: "export", format: "xml", xml: newer, message: next });
    expect(JSON.parse(vi.mocked(api).mock.calls[2][1]!.body as string)).toMatchObject({ content: newer, revision: "r2" });
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saved");
    expect(sent().at(-1)).toEqual({ action: "status", message: "", modified: false });
  });

  it.each(["Ctrl+S", "Cmd+S", "iframe"])("flushes promptly via %s without a save button", async (key) => {
    await mount();
    if (key === "iframe") await send({ event: "shortcut", command: "save" });
    else expect(await saveShortcut(key === "Cmd+S")).toBe(true);
    expect(button("Save")).toBeUndefined();
    const request = sent().at(-1);
    expect(request).toMatchObject({ action: "export", format: "xml" });
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" });
    await send({ event: "export", format: "xml", xml: changed, message: request });
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saved");
  });

  it("keeps the failed autosave draft and only retries after an explicit request", async () => {
    vi.useFakeTimers();
    await mount(); await send({ event: "autosave", xml: changed });
    vi.mocked(api).mockRejectedValueOnce(new Error("Server temporarily unavailable"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Save failed");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Server temporarily unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => button("Retry").click());
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" });
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    expect(api).toHaveBeenCalledTimes(3);
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saved");
  });

  it.each(["save", "pdf"])("closes a saved %s without a false discard warning when export formatting/compression differs", async (kind) => {
    await mount(); await send({ event: "autosave", xml: changed });
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" });
    if (kind === "pdf") vi.mocked(api).mockResolvedValueOnce({ path: "figures/diagram.pdf", pdfRevision: "pdf-r2" });
    if (kind === "pdf") await act(async () => button("Export PDF").click());
    else await saveShortcut();
    const request = sent().at(-1);
    const xml = kind === "pdf" ? compressed(changed) : changed;
    await send({ event: "export", format: kind === "pdf" ? "svg" : "xml", xml,
      data: "data:image/svg+xml,%3Csvg%2F%3E", message: request });
    // Native autosave and close use expanded XML, not the SVG export's data.
    const expanded = changed.replace("<mxfile>", '<mxfile host="embed.diagrams.net" modified="later">\n ')
      .replace(/<mxGraphModel\b/, '<mxGraphModel dx="1200" dy="800"');
    await send({ event: "autosave", xml: expanded });
    await vi.waitFor(() => expect(host.querySelector(".drawio-status")?.textContent).toBe("Saved"));
    await requestClose();
    await send({ event: "export", format: "xml", xml: expanded, message: sent().at(-1) });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api).toHaveBeenCalledTimes(kind === "pdf" ? 3 : 2);
  });

  it("flushes a real edit after a successful compressed PDF save before navigating", async () => {
    await mount();
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" }).mockResolvedValueOnce({ pdfRevision: "pdf-r2" });
    await act(async () => button("Export PDF").click());
    await send({ event: "export", format: "svg", xml: compressed(changed), data: "data:image/svg+xml,%3Csvg%2F%3E", message: sent().at(-1) });
    await act(async () => vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2)));
    const newer = changed.replace("Changed", "Newer");
    await send({ event: "autosave", xml: newer });
    await vi.waitFor(() => expect(host.querySelector(".drawio-status")?.textContent).toBe("Saving…"));
    await requestClose();
    expect(onClose).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce({ revision: "r3" });
    await send({ event: "export", format: "xml", xml: newer, message: sent().at(-1) });
    await act(async () => vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce()));
    expect(JSON.parse(vi.mocked(api).mock.calls[3][1]!.body as string)).toMatchObject({ content: newer, revision: "r2" });
  });

  it("compares full multi-page graph content while ignoring serialization and viewport metadata", async () => {
    const xml = changed.replace("</mxfile>", '<diagram id="second" name="中文"><mxGraphModel><root><mxCell id="0" value="Label"/></root></mxGraphModel></diagram></mxfile>');
    expect(await sameDrawioContent(xml, compressed(xml))).toBe(true);
    expect(await sameDrawioContent(xml, compressed(xml.replace("Label", "Changed label")))).toBe(false);
    expect(await sameDrawioContent(xml, compressed(xml.replace('id="second"', 'id="new-page"')))).toBe(false);
    expect(await sameDrawioContent(xml, compressed(changed))).toBe(false);
    expect(await sameDrawioContent(xml, '<mxfile><diagram>not base64!</diagram></mxfile>')).toBe(false);
  });

  it("does not let an older asynchronous content comparison clear a newer edit", async () => {
    await mount();
    let finish!: (unchanged: boolean) => void;
    vi.spyOn(drawioContent, "sameDrawioContent").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await send({ event: "autosave", xml: `${EMPTY_DRAWIO}\n` });
    await send({ event: "autosave", xml: changed });
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saving…");
    await act(async () => finish(true));
    expect(host.querySelector(".drawio-status")?.textContent).toBe("Saving…");
  });

  it("requires confirmation before replacing a PDF, saves source first, and preserves errors for retry", async () => {
    await mount(false, "pdf-r1");
    await act(async () => button("Export PDF").click());
    expect(sent().at(-1).action).toBe("load");
    await act(async () => button("Replace and export").click());
    const request = sent().at(-1); expect(request).toMatchObject({ format: "svg", embedImages: true, allPages: false, theme: "light", border: 0 });
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" }).mockRejectedValueOnce(new ApiError("Install a browser", 503, "DRAWIO_BROWSER_UNAVAILABLE"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>';
    await send({ event: "export", format: "svg", xml: changed, data: `data:image/svg+xml,${encodeURIComponent(svg)}`, message: request });
    const calls = vi.mocked(api).mock.calls;
    expect(calls[1][1]?.method).toBe("PUT"); expect(calls[2][1]?.method).toBe("POST");
    expect(JSON.parse(calls[2][1]!.body as string)).toEqual({ path: "figures/diagram.drawio", svg, revision: "r2", pdfRevision: "pdf-r1", lockToken: "lease-1" });
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

  it("exports selected content with custom margin but saves the complete source, never the selected XML", async () => {
    await mount();
    const selection = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="selected" value="Selected" vertex="1" parent="1"/></root></mxGraphModel>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Selected</text></svg>';
    vi.mocked(renderDrawioSelection).mockResolvedValue(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" }).mockResolvedValueOnce({ pdfRevision: "pdf-r2" });
    await configureExport("selection", "0");
    await act(async () => button("Export PDF").click());
    expect(frame.parentElement?.hasAttribute("inert")).toBe(true);
    const selectionRequest = sent().at(-1);
    expect(selectionRequest).toMatchObject({ format: "json", allPages: false, selection: true, includeData: true });
    await send({ event: "export", format: "json", data: { data: selection, pages: [{ cells: [{ id: "selected" }] }] }, message: selectionRequest });
    expect(api).toHaveBeenCalledTimes(1);
    expect(sent().at(-1)).toMatchObject({ format: "xml" });
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toMatchObject({ content: changed, revision: "r1" });
    expect(renderDrawioSelection).toHaveBeenCalledWith(selection, 0, "en", expect.any(AbortSignal));
    expect(JSON.parse(vi.mocked(api).mock.calls[2][1]!.body as string)).toMatchObject({ svg, revision: "r2" });
    expect(frame.parentElement?.hasAttribute("inert")).toBe(false);
    expect(sent().filter((message) => message.action === "load")).not.toContainEqual(expect.objectContaining({ xml: selection }));
  });

  it("checks availability on menu open, preserves settings, and never exports while configuring", async () => {
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!;
    await act(async () => toggle.click());
    const first = sent().at(-1);
    expect(first).toMatchObject({ format: "json", selection: true, includeData: false });
    expect(document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!.value).toBe("0");
    const selection = () => document.querySelector<HTMLInputElement>('.drawio-export-options input[value="selection"]')!;
    expect(selection().disabled).toBe(true);
    await send({ event: "export", format: "json", data: { pages: [{ cells: [] }] }, message: first });
    expect(selection().disabled).toBe(true);
    await act(async () => selection().click());
    expect(button("Current page")).toBeDefined();
    await act(async () => {
      const margin = document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(margin, "12");
      margin.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await send({ event: "export", format: "json", data: { pages: [{ cells: [{ id: "a" }] }] }, message: sent().at(-1) });
    expect(selection().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!.value).toBe("12");
    await act(async () => selection().click());
    expect(button("Selected content")).toBeDefined();
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(selection().checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!.value).toBe("12");
    expect(api).toHaveBeenCalledTimes(1);
    expect(renderDrawioSelection).not.toHaveBeenCalled();
    expect(sent().filter((message) => message.action === "export").every((message) => message.format === "json" && !message.includeData)).toBe(true);
  });

  it("discards menu queries after close and does not let late selection results enable an empty selection", async () => {
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!;
    await act(async () => toggle.click()); const old = sent().at(-1);
    await act(async () => toggle.click());
    await act(async () => toggle.click()); const current = sent().at(-1);
    expect(current.requestId).not.toBe(old.requestId);
    await send({ event: "export", format: "json", data: { pages: [{ cells: [{ id: "old" }] }] }, message: old });
    expect(document.querySelector<HTMLInputElement>('.drawio-export-options input[value="selection"]')!.disabled).toBe(true);
    await send({ event: "export", format: "json", data: { pages: [{ cells: [] }] }, message: current });
    expect(document.querySelector<HTMLInputElement>('.drawio-export-options input[value="selection"]')!.disabled).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("rejects empty selection without saving or falling back to the full page, and allows a page export afterwards", async () => {
    await mount(); await configureExport("selection", "16");
    await act(async () => button("Export PDF").click());
    await send({ event: "export", format: "json", data: { pages: [{ cells: [] }] }, message: sent().at(-1) });
    expect(api).toHaveBeenCalledTimes(1); expect(renderDrawioSelection).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("drawio.emptySelection"));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
    await act(async () => document.querySelector<HTMLInputElement>('.drawio-export-options input[value="page"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
    await act(async () => button("Export PDF").click());
    expect(sent().at(-1)).toMatchObject({ format: "svg", allPages: false, border: 16 });
  });

  it("disables export for invalid margin and aborts a disposable selection renderer when cancelled", async () => {
    await mount(); await configureExport("selection", "-1");
    expect(button("Export PDF").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('.drawio-export-options input[type="number"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "4");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="PDF export options"]')!.click());
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" });
    let finish!: (data: string) => void;
    vi.mocked(renderDrawioSelection).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => button("Export PDF").click());
    await send({ event: "export", format: "json", data: { data: "<mxGraphModel><root/></mxGraphModel>", pages: [{ cells: [{ id: "a" }] }] }, message: sent().at(-1) });
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    const signal = vi.mocked(renderDrawioSelection).mock.calls[0][3];
    await act(async () => button("Cancel").click()); expect(signal.aborted).toBe(true);
    await act(async () => finish("data:image/svg+xml,%3Csvg%2F%3E"));
    expect(api).toHaveBeenCalledTimes(2); // No PDF request from the cancelled render.
    expect(button("Export PDF").disabled).toBe(false);
  });

  it("checks current XML on toolbar close even if a recent change has not emitted autosave yet", async () => {
    await mount();
    await act(async () => closeButton().click());
    expect(onClose).not.toHaveBeenCalled();
    expect(closeButton().disabled).toBe(true);
    const request = sent().at(-1); expect(request.format).toBe("xml");
    vi.mocked(api).mockResolvedValueOnce({ revision: "r2" });
    await send({ event: "export", format: "xml", xml: changed, message: request });
    expect(onClose).toHaveBeenCalledOnce(); expect(api).toHaveBeenCalledTimes(2);
  });

  it("closes a read-only diagram without asking the iframe to save", async () => {
    await mount(true);
    await act(async () => closeButton().click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(sent().map(({ action }) => action)).toEqual(["load"]);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight save on navigation and flushes the newer draft with the returned revision", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    let resolve!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await saveShortcut();
    const first = sent().at(-1);
    await send({ event: "export", format: "xml", xml: changed, message: first });
    const latest = changed.replace("Changed", "Newest");
    await send({ event: "autosave", xml: latest });
    await requestClose();
    expect(onClose).not.toHaveBeenCalled();
    expect(sent().at(-1)).toEqual(first);
    await act(async () => resolve({ revision: "r2" }));
    const flush = sent().at(-1);
    expect(flush.requestId).not.toBe(first.requestId);
    vi.mocked(api).mockResolvedValueOnce({ revision: "r3" });
    await send({ event: "export", format: "xml", xml: latest, message: flush });
    expect(JSON.parse(vi.mocked(api).mock.calls[2][1]!.body as string)).toMatchObject({ content: latest, revision: "r2" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels pending writes on close/unmount and ignores their late results", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    await saveShortcut();
    let resolve!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    const signal = vi.mocked(api).mock.calls[1][1]?.signal;
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ revision: "late" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("guards external file navigation with cancel/discard decisions when saving fails", async () => {
    await mount(); await send({ event: "autosave", xml: changed });
    let decision!: Promise<boolean>;
    await act(async () => { decision = editor.current!.confirmClose(); });
    vi.mocked(api).mockRejectedValueOnce(new Error("Server unavailable"));
    await send({ event: "export", format: "xml", xml: changed, message: sent().at(-1) });
    await act(async () => button("Cancel").click());
    await expect(decision).resolves.toBe(false);
    expect(host.querySelector("iframe")).toBe(frame);
    await act(async () => { decision = editor.current!.confirmClose(); });
    await act(async () => button("Discard").click());
    await expect(decision).resolves.toBe(true);
    expect(onClose).not.toHaveBeenCalled(); // The caller now owns switching files.
  });

  it("opens other editors read-only and preserves a local draft when ownership is lost", async () => {
    vi.useFakeTimers();
    lease.state = { status: "busy", token: "", name: "Other writer" }; lease.current.current = lease.state;
    await mount();
    expect(sent()[0]).toMatchObject({ readOnly: true, autosave: 0 });
    expect(button("Export PDF").disabled).toBe(true);
    expect(document.body.textContent).toContain("Other writer is editing this diagram");
    const rerender = () => act(async () => root.render(createElement(DrawioEditor, { ref: editor, projectId: "p1", path: "figures/diagram.drawio", readOnly: false, onChanged, onClose })));
    lease.state = { status: "owned", token: "lease-2", name: "" }; lease.current.current = lease.state;
    await rerender();
    expect(sent().at(-1)).toMatchObject({ action: "load", readOnly: false });
    await send({ event: "autosave", xml: changed });
    const count = sent().length;
    lease.state = { status: "lost", token: "", name: "" }; lease.current.current = lease.state;
    await rerender();
    expect(sent()).toHaveLength(count); // Do not reload and erase the draft.
    expect(frame.parentElement?.hasAttribute("inert")).toBe(true);
    expect(button("Save")).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(sent()).toHaveLength(count); // The scheduled save did not request XML after the lease was lost.
    await send({ event: "save", xml: changed });
    expect(api).toHaveBeenCalledTimes(1);
    await requestClose();
    expect(document.body.textContent).toContain("Discard unsaved diagram changes?");
  });

  it("refreshes a stale clean viewer on acquisition, but never overwrites a disconnected owner's draft", async () => {
    lease.state = { status: "busy", token: "", name: "Writer" }; lease.current.current = lease.state;
    await mount();
    const rerender = () => act(async () => root.render(createElement(DrawioEditor, { ref: editor, projectId: "p1", path: "figures/diagram.drawio", readOnly: false, onChanged, onClose })));
    vi.mocked(api).mockResolvedValueOnce({ content: changed, revision: "r2", pdfRevision: null });
    lease.state = { status: "owned", token: "new-owner", name: "", revision: "r2" }; lease.current.current = lease.state;
    await rerender();
    expect(api).toHaveBeenCalledTimes(2);
    expect(sent().at(-1)).toMatchObject({ action: "load", xml: changed, readOnly: false });
    await send({ event: "autosave", xml: changed.replace("Changed", "Unsaved") });
    lease.state = { status: "lost", token: "", name: "" }; lease.current.current = lease.state; await rerender();
    lease.state = { status: "owned", token: "third-owner", name: "", revision: "r3" }; lease.current.current = lease.state; await rerender();
    expect(api).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(button("Save")).toBeUndefined();
    expect(frame.parentElement?.hasAttribute("inert")).toBe(true);
  });

  it("decodes Unicode SVG exports without fetching arbitrary URLs", () => {
    const svg = '<svg><text>中文</text></svg>';
    const bytes = new TextEncoder().encode(svg);
    expect(decodeDrawioSvg(`data:image/svg+xml;base64,${btoa(String.fromCharCode(...bytes))}`)).toBe(svg);
    for (const value of ["https://evil.test", "data:text/html,<script/>", "data:image/svg+xml,%zz"]) expect(() => decodeDrawioSvg(value)).toThrow();
  });
});
