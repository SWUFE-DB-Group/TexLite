// @vitest-environment happy-dom
import fs from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectListRow } from "../src/client/pages/ProjectListRow";
import type { Project, User } from "../src/client/types";
import i18n from "../src/client/i18n";

let root: Root, host: HTMLDivElement, sheet: HTMLStyleElement;
const user: User = { id: "owner", username: "author", displayName: "Author", role: "user", disabled: false,
  mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-29" };
const project: Project = { id: "paper", name: "A very long collaborative research project title that must leave room for unresolved comments",
  ownerId: "owner", lastModifiedBy: null, mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, icon: null,
  permission: "owner", chktexEnabled: false, createdAt: "2026-10-29", updatedAt: "2026-10-29",
  unresolvedCommentCount: 123, commentCount: 130, tags: [{ id: "year", name: "2027", color: "yellow" }, { id: "topic", name: "Research", color: "blue" }] };
const noop = () => {};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sheet = document.createElement("style"); sheet.textContent = fs.readFileSync("src/client/styles.css", "utf8"); document.head.append(sheet);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); sheet.remove(); vi.unstubAllGlobals(); });

describe("project list title layout", () => {
  it.each(["en", "zh"])("puts tags below the title while protecting the %s unresolved badge", async (language) => {
    await i18n.changeLanguage(language);
    const open = vi.fn();
    await act(async () => root.render(createElement("div", { className: "project-grid list-view" }, createElement(ProjectListRow, {
      project, currentUser: user, showArchived: false, archiveBusy: false, menuOpen: false, t: i18n.t.bind(i18n),
      formatCreatedDate: () => "2026/10/29", formatUpdatedTime: () => "1 day ago", formatExactTime: () => "2026/10/29 12:00",
      onOpenProject: open, onOpenMention: noop, onToggleMenu: noop, onCloseMenu: noop, onAssignTags: noop,
      onRename: noop, onDuplicate: noop, onArchive: noop, onTransfer: noop, onDelete: noop, onChooseIcon: noop
    }))));
    const heading = host.querySelector<HTMLElement>(".project-list-title-line")!;
    const tags = host.querySelector<HTMLElement>(".project-list-tags")!;
    const name = heading.querySelector<HTMLElement>(".project-list-title")!;
    const badge = heading.querySelector<HTMLElement>(".project-comments-badge")!;
    expect(heading.contains(tags)).toBe(false); expect(heading.nextElementSibling).toBe(tags);
    expect(badge.textContent).toBe(i18n.t("projects.unresolvedCount", { count: 123 }));
    expect(name.getAttribute("title")).toBe(project.name);
    expect(getComputedStyle(name).maxWidth).toBe("340px");
    expect(Number.parseFloat(getComputedStyle(name).minWidth)).toBe(0);
    expect(getComputedStyle(name).flexShrink).toBe("1");
    expect(getComputedStyle(badge).flexShrink).toBe("0"); expect(getComputedStyle(badge).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(tags.parentElement!).flexDirection).toBe("column");
    expect(tags.querySelector(".tag-yellow")?.textContent).toBe("2027");
    await act(async () => tags.click()); expect(open).toHaveBeenCalledOnce();
  });
});
