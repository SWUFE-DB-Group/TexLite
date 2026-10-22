// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/client/pages/Dashboard";
import type { Project, SiteConfig, User } from "../src/client/types";
import { scopedStorageKey } from "../src/client/basePath";
import i18n from "../src/client/i18n";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", async (original) => ({ ...await original<object>(), api: apiMock }));
const user: User = { id: "owner", username: "alice", displayName: "Alice", role: "user", disabled: false,
  mustChangePassword: false, canCreateProjects: true, createdAt: "2026-01-01" };
const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "", minPasswordLength: 8,
  maxCitationBibtexBytes: 102400, maxUploadSizeMB: 100, maxCollaborativeFileSizeMB: 10 };
const project = (id: string): Project => ({ id, ownerId: "owner", ownerDisplayName: "Alice", name: id,
  mainFile: "main.tex", lastModifiedBy: "owner", latexmkrc: null, engine: "pdflatex", icon: null,
  chktexEnabled: false, permission: "owner", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  apiMock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("project deletion feedback", () => {
  it.each(["grid", "list"])("updates live data immediately but retains a noninteractive %s card briefly", async (view) => {
    let projects = [project("first"), project("second")];
    const pagination = () => ({ page: 1, pageSize: 20, total: projects.length, totalPages: 1 });
    let finish!: () => void;
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        await new Promise<void>((resolve) => { finish = resolve; });
        projects = projects.filter((item) => item.id !== "first");
        return {};
      }
      return url === "/api/tags" ? { tags: [] } : { projects, pagination: pagination() };
    });
    localStorage.setItem(scopedStorageKey("texlite-project-view"), view);
    const onDataChange = vi.fn();
    await act(async () => root.render(createElement(Dashboard, { site, user,
      initialData: { projects, tags: [], pagination: pagination() }, onDataChange, onUser: vi.fn(), onOpenProject: vi.fn() })));
    await act(async () => host.querySelector<HTMLButtonElement>(".project-action-menu-trigger")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".project-action-menu .danger")!.click());
    const confirm = document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!;
    await act(async () => confirm.click());
    expect(host.querySelector(".deletion-exit")).toBeNull();
    expect(confirm.disabled).toBe(true);
    await act(async () => finish());
    const exit = host.querySelector<HTMLElement>(".deletion-exit")!;
    expect(exit).not.toBeNull();
    expect(exit.inert).toBe(true);
    expect(exit.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".dialog-content")).toBeNull();
    expect(onDataChange.mock.lastCall?.[0].map((item: Project) => item.id)).toEqual(["second"]);
    await act(async () => vi.advanceTimersByTime(300));
    expect(host.querySelector(".deletion-exit")).toBeNull();
    expect(host.querySelectorAll(".project-card")).toHaveLength(1);
  });

  it("does not animate or hide a project when deletion fails", async () => {
    const projects = [project("first")];
    const pagination = { page: 1, pageSize: 20, total: 1, totalPages: 1 };
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new Error("Unable to delete");
      return url === "/api/tags" ? { tags: [] } : { projects, pagination };
    });
    await act(async () => root.render(createElement(Dashboard, { site, user,
      initialData: { projects, tags: [], pagination }, onDataChange: vi.fn(), onUser: vi.fn(), onOpenProject: vi.fn() })));
    await act(async () => host.querySelector<HTMLButtonElement>(".project-action-menu-trigger")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".project-action-menu .danger")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!.click());
    expect(host.querySelector(".deletion-exit")).toBeNull();
    expect(host.querySelectorAll(".project-card")).toHaveLength(1);
    expect(document.querySelector(".dialog-error")?.textContent).toBe("Unable to delete");
  });
});
