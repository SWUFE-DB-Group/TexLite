// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "../src/client/pages/NewProjectDialog";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let host: HTMLDivElement, root: Root;
const opened = vi.fn(), created = vi.fn();
const name = () => document.querySelector<HTMLInputElement>('.new-project-form input:not([type="url"])')!;
const url = () => document.querySelector<HTMLInputElement>('.new-project-form input[type="url"]')!;
const form = () => document.querySelector<HTMLFormElement>(".new-project-form")!;
const template = () => document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => { form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset(); opened.mockReset(); created.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(NewProjectDialog, { open: true, maxUploadSizeMB: 100, onOpenChange: opened, onCreated: created })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("new project dialog", () => {
  it("creates blank projects without sending a template URL", async () => {
    vi.mocked(api).mockResolvedValue({ project: { id: "blank" } });
    await enter(name(), " New paper "); await submit();
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]!.body))).toEqual({ name: "New paper" });
    expect(created).toHaveBeenCalledWith("blank"); expect(opened).toHaveBeenCalledWith(false);
  });

  it("requires a URL only in template mode and prevents duplicate submissions while downloading", async () => {
    let complete!: (result: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="tab"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(template().getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".dialog-header")?.textContent).toContain(i18n.t("projects.newDescription"));
    const help = document.querySelector<HTMLButtonElement>(".new-project-url-label .info-popover-trigger")!;
    expect(document.querySelector(".info-popover-content")).toBeNull();
    await act(async () => help.click());
    const popover = document.querySelector(".info-popover-content")!;
    expect(popover.textContent).toContain("100 MB");
    const templatesLink = popover.querySelector<HTMLAnchorElement>("a")!;
    expect(templatesLink.href).toBe("https://latextemplates.com/");
    expect(templatesLink.target).toBe("_blank");
    await act(async () => help.click());
    expect(document.querySelector(".info-popover-content")).toBeNull();
    await enter(name(), "My template"); await submit(); expect(api).not.toHaveBeenCalled();
    await enter(url(), "https://example.org/download?id=1");
    await submit(); await submit();
    expect(api).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(i18n.t("projects.downloadingTemplate"));
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]!.body))).toEqual({ name: "My template", templateUrl: "https://example.org/download?id=1" });
    expect(url().disabled).toBe(true); expect(template().disabled).toBe(true);
    await act(async () => complete({ project: { id: "imported" } }));
    expect(created).toHaveBeenCalledWith("imported");
    expect(name().value).toBe(""); expect(url()).toBeNull();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("preserves template input on failure and allows retry", async () => {
    await act(async () => template().click());
    await enter(name(), "Retry paper"); await enter(url(), "https://example.org/template.zip");
    vi.mocked(api).mockRejectedValueOnce(new Error("Download failed"));
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Download failed");
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(form().getAttribute("aria-busy")).toBe("false");
    expect(url().value).toBe("https://example.org/template.zip"); expect(name().value).toBe("Retry paper");
    vi.mocked(api).mockResolvedValueOnce({ project: { id: "retry" } }); await submit();
    expect(created).toHaveBeenCalledWith("retry");
  });
});
