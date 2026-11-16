// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/client/pages/Dashboard";
import { api, apiUpload } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { SiteConfig, User } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn(), apiUpload: vi.fn() }));
vi.mock("../src/client/agents/useAgentAccess", () => ({ useAgentAccess: () => ({ visible: false, activeCount: 0 }) }));
vi.mock("../src/client/UpdateNotification", () => ({ UpdateNotification: () => null }));
const user: User = { id: "me", username: "writer", displayName: "Writer", role: "user", disabled: false,
  mustChangePassword: false, canCreateProjects: true, createdAt: "2026-01-01" };
const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "", minPasswordLength: 8,
  maxCitationBibtexBytes: 102400, maxUploadSizeMB: 100, maxCollaborativeFileSizeMB: 10 };
const pagination = { page: 1, pageSize: 32, total: 0, totalPages: 0 }, counts = { all: 0, owned: 0, shared: 0 };
let root: Root, host: HTMLDivElement;
const opened = vi.fn();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const importButton = () => [...dialog().querySelectorAll<HTMLButtonElement>(".dialog-footer button")].find((button) => button.classList.contains("primary"))!;
const progress = () => dialog().querySelector<HTMLProgressElement>("progress")!;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en"); opened.mockReset();
  vi.mocked(api).mockReset().mockImplementation(async (url) => (url === "/api/tags" ? { tags: [] } : { projects: [], pagination, counts, archivedCounts: counts }) as never);
  vi.mocked(apiUpload).mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Dashboard, { site, user,
    initialData: { projects: [], tags: [], pagination, counts, archivedCounts: counts, filters: { ownership: "all", archived: false, search: "", tag: "", sort: "updated" } },
    onDataChange: () => {}, onUser: () => {}, onOpenProject: opened })));
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("projects.upload")}"]`)!.click());
  const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["archive"], "paper.zip", { type: "application/zip" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("project upload feedback", () => {
  it("keeps upload percentages, switches to indeterminate processing, and closes on success", async () => {
    let callbacks!: NonNullable<Parameters<typeof apiUpload>[2]>, finish!: (value: unknown) => void;
    vi.mocked(apiUpload).mockImplementation((_url, _data, options) => { callbacks = options!; return new Promise((resolve) => { finish = resolve; }); });
    await act(async () => importButton().click());
    expect(dialog().classList.contains("is-importing")).toBe(true);
    const activity = dialog().querySelector(".project-import-activity");
    expect(activity?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => callbacks.onProgress!(42, 100));
    expect(progress().value).toBe(42);
    expect(dialog().querySelector(".project-import-progress-label small")?.textContent).toBe("42%");
    await act(async () => callbacks.onUploadComplete!());
    expect(dialog().querySelector(".project-import-activity")).toBe(activity);
    expect(progress().hasAttribute("value")).toBe(false);
    expect(dialog().querySelector(".project-import-progress-label small")).toBeNull();
    expect(importButton().textContent).toContain(i18n.t("projects.processing"));
    await act(async () => dialog().querySelector<HTMLButtonElement>(".dialog-close")!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => finish({ project: { id: "uploaded" } }));
    expect(dialog()).toBeNull(); expect(opened).toHaveBeenCalledWith("uploaded");
  });

  it("restores controls and retains the selected file after a failed import", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(apiUpload).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => importButton().click());
    expect(dialog().classList.contains("is-importing")).toBe(true);
    await act(async () => fail(new Error("Import failed")));
    expect(dialog().classList.contains("is-importing")).toBe(false);
    expect(dialog().querySelector(".project-import-activity")).toBeNull();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Import failed");
    expect(dialog().querySelector(".project-import-progress")).toBeNull();
    expect(dialog().querySelector(".upload-picker-copy strong")?.textContent).toBe("paper.zip");
    expect(importButton().disabled).toBe(false);
  });
});
