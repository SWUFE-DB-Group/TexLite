// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAWIO_ORIGIN } from "../src/shared/drawio";
import { renderDrawioSelection, selectedDrawioXml } from "../src/client/workspace/drawioSelectionExport";

let controller: AbortController;
let frame: HTMLIFrameElement;
const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="selected" value="中文" vertex="1" parent="0"/></root></mxGraphModel>';
const start = (margin = 0) => {
  const result = renderDrawioSelection(xml, margin, "zh", controller.signal);
  frame = document.querySelector(".drawio-export-frame")!;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  return result;
};
const send = (data: object, origin = DRAWIO_ORIGIN, source = frame.contentWindow) => window.dispatchEvent(new MessageEvent("message", { origin, source, data: JSON.stringify(data) }));
const sent = () => vi.mocked(frame.contentWindow!.postMessage).mock.calls.map(([message]) => JSON.parse(message as string));
beforeEach(() => {
  controller = new AbortController();
  const getAttribute = HTMLIFrameElement.prototype.getAttribute;
  vi.spyOn(HTMLIFrameElement.prototype, "getAttribute").mockImplementation(function (this: HTMLIFrameElement, name: string) {
    return name === "srcdoc" ? "" : getAttribute.call(this, name);
  });
});
afterEach(() => { controller.abort(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("isolated draw.io selection rendering", () => {
  it("accepts only the renderer window and exact origin/request, and removes the frame on success", async () => {
    const result = start(12);
    expect(frame.tabIndex).toBe(-1); expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.inert).toBe(true);
    expect(frame.src).not.toContain(xml);
    send({ event: "configure" }); send({ event: "init" });
    expect(sent().at(-1)).toMatchObject({ action: "load", xml, readOnly: true, autosave: 0 });
    send({ event: "load" });
    expect(sent().at(-1)).toMatchObject({ action: "export", format: "svg", allPages: false, border: 12 });
    const response = { event: "export", format: "svg", message: { requestId: 1 }, data: "data:image/svg+xml,%3Csvg%2F%3E" };
    send(response, "https://other.test"); send(response, DRAWIO_ORIGIN, window); send({ ...response, message: { requestId: 2 } });
    expect(document.querySelector(".drawio-export-frame")).toBe(frame);
    send(response);
    await expect(result).resolves.toBe(response.data);
    expect(document.querySelector(".drawio-export-frame")).toBeNull();
  });

  it.each(["cancel", "timeout", "invalid"])("cleans up the renderer after %s", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = start();
    const rejected = expect(result).rejects.toMatchObject(reason === "cancel" ? { name: "AbortError" } : { message: reason === "invalid" ? "DRAWIO_INVALID" : "DRAWIO_EXPORT_FAILED" });
    if (reason === "cancel") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    else send({ event: "load", error: "invalid XML" });
    await rejected;
    expect(document.querySelector(".drawio-export-frame")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes empty selections from valid lossless XML and malformed responses", () => {
    expect(selectedDrawioXml({ pages: [{ cells: [] }] })).toBeNull();
    expect(selectedDrawioXml({ data: xml, pages: [{ cells: [{ id: "selected" }] }] })).toBe(xml);
    for (const response of [null, { pages: [] }, { data: "<mxfile/>", pages: [{ cells: [{}] }] }]) {
      expect(() => selectedDrawioXml(response)).toThrow("DRAWIO_INVALID");
    }
  });
});
