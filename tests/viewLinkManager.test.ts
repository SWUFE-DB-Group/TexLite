// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import { ViewLinkManager } from "../src/client/workspace/ViewLinkManager";
import type { ProjectViewLink } from "../src/shared/projectViewLinks";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let host: HTMLDivElement, root: Root;
const busy = vi.fn(), writeText = vi.fn();
const link: ProjectViewLink = { id: "link", label: "Reviewer", createdAt: new Date().toISOString(), expiresAt: null, path: "/share/link#original" };
let saved: ProjectViewLink[];
const click = (element: HTMLElement) => act(async () => { element.click(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label)!;
const reopen = async () => {
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(createElement(ViewLinkManager, { projectId: "paper", onBusyChange: busy })));
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en"); busy.mockReset(); writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  saved = [{ ...link }];
  vi.mocked(api).mockReset().mockImplementation(async (url, options) => {
    if (!options?.method) return { links: saved.map((item) => ({ ...item })) } as never;
    if (options.method === "DELETE") { saved = saved.filter((item) => item.id !== link.id); return { ok: true } as never; }
    const created = { ...link, id: "created", path: "/share/created#secret" }; saved.unshift(created);
    return { link: created, path: created.path } as never;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ViewLinkManager, { projectId: "paper", onBusyChange: busy })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("owner read-only link management", () => {
  it("defaults to seven days, displays saved addresses and confirms copy on the button", async () => {
    saved = []; await reopen();
    await click(button("Create link"));
    const post = vi.mocked(api).mock.calls.find(([, options]) => options?.method === "POST")!;
    const expiry = JSON.parse(String(post[1]?.body)).expiresAt;
    expect(Date.parse(expiry) - Date.now()).toBeGreaterThan(6.99 * 24 * 3600_000);
    expect(host.querySelector<HTMLInputElement>(".view-link-address input")?.value).toContain("/share/created#secret");
    await click(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/share/created#secret"));
    expect(button("Copied")).toBeDefined(); expect(busy).toHaveBeenCalledWith(true); expect(busy).toHaveBeenLastCalledWith(false);
    await reopen();
    expect(host.querySelector<HTMLInputElement>(".view-link-address input")?.value).toContain("/share/created#secret");
    await click(button("Copy link"));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("/share/created#secret"));
  });

  it("offers only copy and delete for an active link and copies the same address repeatedly", async () => {
    expect(host.querySelector(".view-link-create")).toBeNull();
    expect([...host.querySelectorAll("button")].map((node) => node.getAttribute("aria-label") || node.textContent))
      .toEqual(["Delete link", "Copy link"]);
    await click(button("Copy link")); await click(button("Copied"));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("/share/link#original"));
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("keeps a non-recoverable link deletable without replacing it automatically", async () => {
    saved = [{ ...link, path: null }]; await reopen();
    expect(button("Copy link").disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>(".view-link-address input")?.placeholder).toContain("Delete this link");
    expect(button("Delete link").disabled).toBe(false);
    expect(host.querySelector(".view-link-create")).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("shows creation again when a link expires while the dialog stays open", async () => {
    vi.useFakeTimers();
    saved = [{ ...link, expiresAt: new Date(Date.now() + 1000).toISOString() }]; await reopen();
    expect(host.querySelector(".view-link-create")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1001));
    expect(host.querySelector(".view-link-create")).not.toBeNull();
    expect(host.querySelector(".view-link-status")?.textContent).toBe("Expired");
    expect(button("Copy link").disabled).toBe(true);
  });

  it("disables duplicate creation and keeps failures inline", async () => {
    saved = []; await reopen();
    let reject!: (error: Error) => void;
    vi.mocked(api).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    await click(button("Create link"));
    expect(button("Create link").disabled).toBe(true);
    await click(button("Create link"));
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await act(async () => reject(new Error("Network unavailable")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable");
    expect(button("Create link").disabled).toBe(false);
  });

  it("reloads the fixed address when another tab already created a link", async () => {
    saved = []; await reopen(); saved = [{ ...link }];
    vi.mocked(api).mockRejectedValueOnce(new ApiError("An active link already exists.", 409, "VIEW_LINK_EXISTS"));
    await click(button("Create link"));
    expect(host.querySelector(".view-link-create")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("already exists");
    await click(button("Copy link"));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("#original"));
  });

  it("removes the revoked row and its displayed URL without rendering a revoked status", async () => {
    await click(button("Delete link"));
    expect(host.querySelectorAll(".view-link-item")).toHaveLength(1);
    const normalApi = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementationOnce(async () => { throw new Error("Connection interrupted"); });
    await click(document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!);
    expect(host.querySelectorAll(".view-link-item")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>(".view-link-address input")?.value).toContain("#original");
    expect(document.body.textContent).toContain("Connection interrupted");
    vi.mocked(api).mockImplementation(normalApi);
    await click(document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!);
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/projects/paper/view-links/link", expect.objectContaining({ method: "DELETE" }));
    expect(host.querySelectorAll(".view-link-item")).toHaveLength(0);
    expect(host.querySelector(".view-link-address")).toBeNull();
    expect(host.textContent).toContain("No read-only links yet");
    expect(host.textContent).not.toContain("Revoked");
    expect(host.querySelector(".view-link-create")).not.toBeNull();
    await click(button("Create link"));
    expect(host.querySelector<HTMLInputElement>(".view-link-address input")?.value).toContain("/share/created#secret");
    expect(host.querySelector(".view-link-create")).toBeNull();
  });
});
