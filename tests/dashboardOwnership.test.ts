// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/client/pages/Dashboard";
import type { DashboardData, Project, ProjectOwnershipScope, SiteConfig, User } from "../src/client/types";
import { scopedStorageKey } from "../src/client/basePath";
import i18n from "../src/client/i18n";
import { GlobalTooltip } from "../src/client/GlobalTooltip";

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
const onOpenProject = vi.fn();

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
  const pageSize = Number(params.get("pageSize") ?? 32);
  const totalPages = Math.ceil(scoped.length / pageSize);
  const page = Math.max(1, Math.min(Number(params.get("page") ?? 1), totalPages));
  return { projects: scoped.slice((page - 1) * pageSize, page * pageSize), counts,
    pagination: { page, pageSize, total: scoped.length, totalPages } };
}
const projectCalls = () => apiMock.mock.calls.filter(([url]) => String(url).startsWith("/api/projects?"));
const lastParams = () => new URL(String(projectCalls().at(-1)![0]), "http://localhost").searchParams;
const tab = (scope: ProjectOwnershipScope) => host.querySelector<HTMLButtonElement>(`#project-tab-${scope}`)!;
const names = () => Array.from(host.querySelectorAll(".project-card-title, .project-list-title"), (node) => node.textContent);
const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
const render = (initialData: DashboardData | null = null) => act(async () => root.render(createElement(Fragment, null,
  createElement(Dashboard, { site, user, initialData, onDataChange, onUser: vi.fn(), onOpenProject }), createElement(GlobalTooltip))));
const changeSearch = (value: string) => act(async () => {
  const field = host.querySelector<HTMLInputElement>('.project-toolbar input[type="search"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  localStorage.clear(); onDataChange.mockClear(); onOpenProject.mockClear(); archived = new Set();
  projects = [...Array.from({ length: 23 }, (_, index) => makeProject(true, index)), ...Array.from({ length: 24 }, (_, index) => makeProject(false, index))];
  apiMock.mockReset().mockImplementation(async (url: string) => url === "/api/tags" ? { tags: [tag] } : response(url));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("project ownership tabs", () => {
  it("shows source metadata even with tags, keeps empty paper blank and separates card/menu actions", async () => {
    projects = [
      { ...makeProject(true, 0), ownerDisplayName: "Administrator", unresolvedCommentCount: 5, unreadMentionCount: 1,
        lastModifiedDisplayName: "Grace", preview: { title: "Real source title", abstract: "A readable research summary." } },
      { ...makeProject(true, 1), preview: { title: "Title without an abstract", abstract: "" } },
      { ...makeProject(true, 2), tags: [], preview: { title: "", abstract: "" } },
      { ...makeProject(true, 3), preview: null }
    ];
    await render();
    expect(lastParams().get("previews")).toBe("1");
    const cards = [...host.querySelectorAll<HTMLElement>(".project-grid-card")];
    expect(cards).toHaveLength(4);
    const badges = cards[0].querySelector(".project-card-badges")!;
    expect(badges.querySelector(".project-mentions-badge")?.textContent).toBe("1");
    expect(badges.querySelector(".project-comments-badge")?.textContent).toBe("5");
    expect(badges.querySelector<HTMLElement>(".project-comments-badge")?.dataset.tooltip).toBe("5 unresolved");
    expect(badges.firstElementChild?.classList.contains("project-mentions-badge")).toBe(true);
    expect(cards[0].querySelector(".project-card-tags")?.textContent).toBe("Research");
    expect(cards[0].querySelector(".project-paper-title")?.textContent).toBe("Real source title");
    expect(cards[0].querySelector(".project-paper-summary")?.textContent).toBe("A readable research summary.");
    expect(cards[0].querySelector(".project-paper-summary")?.nextElementSibling?.className).toBe("project-paper-lines");
    expect(cards[1].querySelector(".project-paper-lines")).not.toBeNull();
    expect(cards[2].querySelector(".project-paper")?.childElementCount).toBe(0);
    expect(cards[3].querySelector(".project-paper-heading")).not.toBeNull();
    expect(cards[0].querySelector(".project-card-modifier")?.textContent).toBe("Grace");
    expect(cards[0].querySelector(".project-paper-abstract-label")?.textContent).toBe("Abstract");
    await act(async () => cards[0].querySelector(".project-card-title")!.dispatchEvent(new Event("pointerover", { bubbles: true })));
    const nameTooltip = host.querySelector('[role="tooltip"]')!;
    expect(nameTooltip.querySelector("strong")?.textContent).toBe(projects[0].name);
    expect(nameTooltip.textContent).toBe(`${projects[0].name}, owned by Administrator`);
    expect([...nameTooltip.querySelectorAll("strong")].map((name) => name.textContent)).toEqual([projects[0].name, "Administrator"]);
    expect(nameTooltip.querySelector("time")).toBeNull();
    expect(nameTooltip.textContent).not.toContain("Grace");
    await act(async () => cards[0].querySelector(".project-card-metadata time")!.dispatchEvent(new Event("pointerover", { bubbles: true })));
    const timeTooltip = host.querySelector('[role="tooltip"]')!;
    const details = [...timeTooltip.querySelectorAll("li")];
    expect(details).toHaveLength(2);
    expect(details[0].textContent).toContain("Created at");
    expect(details[1].textContent).toContain("Last modified at");
    expect(details[1].textContent).toContain("by Grace");
    expect(timeTooltip.querySelectorAll("li > svg")).toHaveLength(2);
    expect(timeTooltip.textContent).not.toContain("owned by");
    expect(timeTooltip.querySelector("strong")?.textContent).toBe("Grace");
    expect(host.querySelector(".project-icon-avatar, .owner-badge, .project-meta")).toBeNull();
    expect(host.querySelector("button button")).toBeNull();
    await click(".project-action-menu-trigger");
    expect(onOpenProject).not.toHaveBeenCalled();
    await click(".project-card-open");
    expect(onOpenProject).toHaveBeenCalledWith(projects[0].id);
    await click(".view-toggle button:last-child");
    expect(lastParams().has("previews")).toBe(false);
    expect(host.querySelector(".project-card-preview")).toBeNull();
    expect(host.querySelector(".project-list-title-line .project-comments-badge")?.textContent).toBe("5 unresolved");
  });

  it.each(["en", "zh", "zh-Hant"])("emphasizes only attribution names without treating %s user text as markup", async (language) => {
    await i18n.changeLanguage(language);
    const owner = "Owner <img src=x> & team", editor = "Editor <em>name</em>";
    projects = [{ ...makeProject(true, 0), ownerDisplayName: owner, lastModifiedDisplayName: editor }];
    await render();
    await act(async () => host.querySelector(".project-card-title")!.dispatchEvent(new Event("pointerover", { bubbles: true })));
    let tooltip = host.querySelector('[role="tooltip"]')!;
    expect([...tooltip.querySelectorAll("strong")].map((name) => name.textContent)).toEqual([projects[0].name, owner]);
    expect(tooltip.querySelector("img, em")).toBeNull();
    await act(async () => host.querySelector(".project-card-metadata time")!.dispatchEvent(new Event("pointerover", { bubbles: true })));
    tooltip = host.querySelector('[role="tooltip"]')!;
    expect([...tooltip.querySelectorAll("strong")].map((name) => name.textContent)).toEqual([editor]);
    expect(tooltip.querySelector("img, em")).toBeNull();
  });

  it.each(["grid", "list"])("keeps the %s UI, counts all pages and resets pagination when changing ownership", async (view) => {
    projects = [...Array.from({ length: 33 }, (_, index) => makeProject(true, index)), ...Array.from({ length: 34 }, (_, index) => makeProject(false, index))];
    localStorage.setItem(scopedStorageKey("texlite-project-view"), view);
    await render();
    expect(host.querySelector(".section-title")!.nextElementSibling).toBe(host.querySelector(".project-ownership-tabs"));
    expect(tab("all").getAttribute("aria-selected")).toBe("true");
    expect([tab("all"), tab("owned"), tab("shared")].map((button) => button.querySelector("sup")?.textContent)).toEqual(["67", "33", "34"]);
    expect(lastParams().get("pageSize")).toBe("32");
    expect(names()).toHaveLength(32);
    await click('#project-tab-owned');
    await click('.project-pagination button:last-child');
    expect(lastParams().get("scope")).toBe("owned"); expect(lastParams().get("page")).toBe("2");
    expect(names()).toHaveLength(1); expect(names().every((name) => name!.startsWith("Owned"))).toBe(true);
    await click('#project-tab-owned'); expect(lastParams().get("page")).toBe("2");
    await click('#project-tab-shared');
    expect(lastParams().get("scope")).toBe("shared"); expect(lastParams().get("page")).toBe("1");
    expect(names()).toHaveLength(32); expect(names().every((name) => name!.startsWith("Shared"))).toBe(true);
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
    projects.push(...Array.from({ length: 10 }, (_, index) => makeProject(false, index + 24)));
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
    expect(names()).toHaveLength(2); expect(names().every((name) => name!.startsWith("Shared"))).toBe(true);
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
