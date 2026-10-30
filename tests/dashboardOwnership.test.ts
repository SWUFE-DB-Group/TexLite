// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/client/pages/Dashboard";
import type { DashboardData, Project, ProjectOwnershipScope, SiteConfig, User } from "../src/client/types";
import { scopedStorageKey } from "../src/client/basePath";
import i18n from "../src/client/i18n";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", async (original) => ({ ...await original<object>(), api: apiMock }));
vi.mock("../src/client/agents/useAgentAccess", () => ({ useAgentAccess: () => ({ visible: false, activeCount: 0 }) }));

const user: User = { id: "me", username: "alice", displayName: "Alice", role: "user", disabled: false,
  mustChangePassword: false, canCreateProjects: true, createdAt: "2026-01-01" };
const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "", minPasswordLength: 8,
  maxCitationBibtexBytes: 102400, maxUploadSizeMB: 100, maxCollaborativeFileSizeMB: 10 };
const tag = { id: "research", name: "Research", color: "blue" as const };
const makeProject = (owned: boolean, index: number): Project => ({ id: `${owned ? "owned" : "shared"}-${index}`,
  ownerId: owned ? "me" : "other", ownerDisplayName: owned ? "Alice" : "Bob", name: `${owned ? "Owned" : "Shared"} Paper ${index}`,
  mainFile: "main.tex", lastModifiedBy: "me", latexmkrc: null, engine: "pdflatex", icon: null, chktexEnabled: false,
  permission: owned ? "owner" : index % 2 ? "edit" : "read", tags: index % 2 ? [] : [tag],
  createdAt: "2026-01-01", updatedAt: "2026-01-01" });
let host: HTMLDivElement, root: Root;
let projects: Project[];
let archived: Set<string>;
const onDataChange = vi.fn<(data: DashboardData) => void>();

function response(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  const search = (params.get("search") ?? "").toLowerCase();
  const matching = projects.filter((project) => project.name.toLowerCase().includes(search)
    && (!params.get("tag") || project.tags.some((tag) => tag.id === params.get("tag"))));
  const counts = { all: matching.length, owned: matching.filter((project) => project.ownerId === user.id).length,
    shared: matching.filter((project) => project.ownerId !== user.id).length };
  const scoped = matching.filter((project) => archived.has(project.id) === (params.get("archived") === "1"))
    .filter((project) => params.get("scope") === "owned" ? project.ownerId === user.id
      : params.get("scope") === "shared" ? project.ownerId !== user.id : true);
  const totalPages = Math.ceil(scoped.length / 20);
  const page = Math.max(1, Math.min(Number(params.get("page") ?? 1), totalPages));
  return { projects: scoped.slice((page - 1) * 20, page * 20), counts,
    pagination: { page, pageSize: 20, total: scoped.length, totalPages } };
}
const projectCalls = () => apiMock.mock.calls.filter(([url]) => String(url).startsWith("/api/projects?"));
const lastParams = () => new URL(String(projectCalls().at(-1)![0]), "http://localhost").searchParams;
const tab = (scope: ProjectOwnershipScope) => host.querySelector<HTMLButtonElement>(`#project-tab-${scope}`)!;
const names = () => Array.from(host.querySelectorAll(".project-card-title, .project-list-title"), (node) => node.textContent);
const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
const render = (initialData: DashboardData | null = null) => act(async () => root.render(createElement(Dashboard,
  { site, user, initialData, onDataChange, onUser: vi.fn(), onOpenProject: vi.fn() })));
const changeSearch = (value: string) => act(async () => {
  const field = host.querySelector<HTMLInputElement>('.project-toolbar input[type="search"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  localStorage.clear(); onDataChange.mockClear(); archived = new Set();
  projects = [...Array.from({ length: 23 }, (_, index) => makeProject(true, index)), ...Array.from({ length: 24 }, (_, index) => makeProject(false, index))];
  apiMock.mockReset().mockImplementation(async (url: string) => url === "/api/tags" ? { tags: [tag] } : response(url));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("project ownership tabs", () => {
  it.each(["grid", "list"])("keeps the %s UI, counts all pages and resets pagination when changing ownership", async (view) => {
    localStorage.setItem(scopedStorageKey("texlite-project-view"), view);
    await render();
    expect(host.querySelector(".section-title")!.nextElementSibling).toBe(host.querySelector(".project-ownership-tabs"));
    expect(tab("all").getAttribute("aria-selected")).toBe("true");
    expect([tab("all"), tab("owned"), tab("shared")].map((button) => button.querySelector("sup")?.textContent)).toEqual(["47", "23", "24"]);
    expect(names()).toHaveLength(20);
    await click('#project-tab-owned');
    await click('.project-pagination button:last-child');
    expect(lastParams().get("scope")).toBe("owned"); expect(lastParams().get("page")).toBe("2");
    expect(names()).toHaveLength(3); expect(names().every((name) => name!.startsWith("Owned"))).toBe(true);
    await click('#project-tab-owned'); expect(lastParams().get("page")).toBe("2");
    await click('#project-tab-shared');
    expect(lastParams().get("scope")).toBe("shared"); expect(lastParams().get("page")).toBe("1");
    expect(names()).toHaveLength(20); expect(names().every((name) => name!.startsWith("Shared"))).toBe(true);
    expect(host.querySelector(".project-grid")!.classList.contains("list-view")).toBe(view === "list");
  });

  it("keeps search, private tags and archive filtering inside every category and hides zero badges", async () => {
    archived.add("shared-0");
    await render(); await click('#project-tab-shared');
    await changeSearch("Shared");
    await click('.project-tag-toggle'); await click('.project-tag-filters button:last-child');
    expect(lastParams().get("tag")).toBe(tag.id); expect(lastParams().get("scope")).toBe("shared");
    expect(names()).toHaveLength(11); expect(tab("owned").querySelector("sup")).toBeNull();
    expect(tab("all").querySelector("sup")?.textContent).toBe("12");
    await click('#project-tab-owned');
    expect(lastParams().get("search")).toBe("Shared"); expect(lastParams().get("tag")).toBe(tag.id);
    expect(names()).toEqual([]); expect(host.textContent).toContain(i18n.t("projects.noMatches"));
    await click('#project-tab-shared'); await click('.project-scope button:last-child');
    expect(lastParams().get("archived")).toBe("1"); expect(names()).toEqual(["Shared Paper 0"]);
    expect(tab("all").querySelector("sup")?.textContent).toBe("12");
    await changeSearch("Not found");
    expect(host.querySelectorAll('.project-ownership-tabs sup')).toHaveLength(0);
    expect(host.querySelector('.project-empty-archived')).toBeNull();
  });

  it("rejects obsolete responses and never displays the previous category's rows while loading", async () => {
    await render();
    const pending = new Map<string, { resolve: (result: ReturnType<typeof response>) => void; signal: AbortSignal }>();
    apiMock.mockImplementation((url: string, options: RequestInit) => url === "/api/tags" ? Promise.resolve({ tags: [tag] })
      : new Promise((resolve) => pending.set(new URL(url, "http://localhost").searchParams.get("scope")!, { resolve, signal: options.signal! })));
    await click('#project-tab-owned'); expect(names()).toEqual([]);
    await click('#project-tab-shared');
    expect(pending.get("owned")!.signal.aborted).toBe(true);
    expect(host.querySelector('[role="tabpanel"]')!.getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.get("shared")!.resolve(response("/api/projects?scope=shared")));
    await act(async () => pending.get("owned")!.resolve(response("/api/projects?scope=owned")));
    expect(names().every((name) => name!.startsWith("Shared"))).toBe(true);
    expect(tab("shared").getAttribute("aria-selected")).toBe("true");
    expect(onDataChange.mock.lastCall![0].filters.ownership).toBe("shared");
  });

  it("restores the category, filters and page together when returning from a project", async () => {
    await render(); await click('#project-tab-shared'); await changeSearch("Paper");
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('.project-sort select')!;
      select.value = "created"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click('.project-pagination button:last-child');
    const cached = onDataChange.mock.lastCall![0];
    expect(cached.pagination.page).toBe(2);
    await act(async () => root.render(null));
    await render(cached);
    expect(tab("shared").getAttribute("aria-selected")).toBe("true");
    expect(lastParams().get("page")).toBe("2"); expect(lastParams().get("search")).toBe("Paper");
    expect(lastParams().get("sort")).toBe("created");
    expect(names()).toHaveLength(4); expect(names().every((name) => name!.startsWith("Shared"))).toBe(true);
  });

  it("supports arrow-key category changes and preserves counts when archiving or unarchiving", async () => {
    await render();
    await act(async () => {
      tab("all").focus(); tab("all").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tab("owned").getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(tab("owned"));
    const normal = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === "PUT") { archived.add(url.split("/")[3]); return { ok: true }; }
      if (options?.method === "DELETE") { archived.delete(url.split("/")[3]); return { ok: true }; }
      return normal(url, options);
    });
    await click('.project-action-menu-trigger');
    const archiveButton = Array.from(host.querySelectorAll<HTMLButtonElement>('.project-action-menu button')).find((button) => button.textContent?.trim() === i18n.t("projects.archive"))!;
    await act(async () => archiveButton.click());
    expect(tab("all").querySelector("sup")?.textContent).toBe("47");
    expect(tab("owned").querySelector("sup")?.textContent).toBe("23");
    expect(tab("shared").querySelector("sup")?.textContent).toBe("24");
    expect(onDataChange.mock.lastCall![0].pagination.total).toBe(22);
    await click('.project-scope button:last-child');
    expect(names()).toHaveLength(1);
    await click('.project-action-menu-trigger');
    const unarchiveButton = Array.from(host.querySelectorAll<HTMLButtonElement>('.project-action-menu button')).find((button) => button.textContent?.trim() === i18n.t("projects.unarchive"))!;
    await act(async () => unarchiveButton.click());
    expect(names()).toHaveLength(0);
    expect(onDataChange.mock.lastCall![0].pagination.total).toBe(0);
    // Includes optimistic updates, not just the final server response.
    expect(onDataChange.mock.calls.every(([data]) => data.counts.all === 47 && data.counts.owned === 23 && data.counts.shared === 24)).toBe(true);
  });

  it("shows all-project counts even when the current archive state has no results", async () => {
    projects = [makeProject(true, 0), makeProject(false, 0)];
    projects.forEach((project) => archived.add(project.id));
    await render();
    expect(names()).toEqual([]);
    const badges = () => [tab("all"), tab("owned"), tab("shared")].map((button) => button.querySelector("sup")?.textContent);
    expect(badges()).toEqual(["2", "1", "1"]);
    expect(onDataChange.mock.lastCall![0].pagination.total).toBe(0);
    await click('.project-scope button:last-child');
    expect(names()).toHaveLength(2);
    expect(badges()).toEqual(["2", "1", "1"]);
    await click('.project-scope button:first-child');
    expect(names()).toEqual([]);
    expect(badges()).toEqual(["2", "1", "1"]);
  });
});
