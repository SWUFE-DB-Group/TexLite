// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { ShareDialog } from "../src/client/workspace/Comments";
import type { ShareUser } from "../src/client/workspace/ShareUserPicker";
import type { Project } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

const project: Project = { id: "paper", name: "Paper", ownerId: "owner", ownerUsername: "owner", ownerDisplayName: "Project Owner",
  lastModifiedBy: null, mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, icon: null,
  permission: "owner", chktexEnabled: false, tags: [], createdAt: "2026-10-29", updatedAt: "2026-10-29" };
const users: ShareUser[] = [
  { id: "owner", username: "owner", displayName: "Project Owner" },
  { id: "member", username: "existing", displayName: "Current Member" },
  { id: "alice", username: "alice.research", displayName: "Alice Chen" },
  { id: "bob", username: "bob", displayName: "同名用户" },
  { id: "carol", username: "carol", displayName: "同名用户" }
];
let directory: ShareUser[], members: Array<ShareUser & { permission: "read" | "edit" }>;
let root: Root, host: HTMLDivElement;
const onOpenChange = vi.fn();
const onMemberCountChange = vi.fn();
const scope = () => document.querySelector<HTMLElement>(".share-dialog")!;
const search = () => scope().querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLButtonElement>('.share-user-popover [role="option"]')];
const permission = () => scope().querySelector<HTMLSelectElement>(".share-add .form-field select")!;
const add = () => scope().querySelector<HTMLButtonElement>(".share-add > button")!;
const writes = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PUT");
const click = (element: HTMLElement) => act(async () => element.click());
const key = (element: HTMLElement, key: string, isComposing = false) => act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true })));
const input = (value: string) => act(async () => {
  const field = search();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const choosePermission = (value: string) => act(async () => {
  const field = permission(); field.value = value; field.dispatchEvent(new Event("change", { bubbles: true }));
});
const chooseUser = async (id: string) => {
  await click(search()); await click(options().find((option) => option.id.endsWith(`-user-${id}`))!);
};
const render = (current = project, open = true) => act(async () => root.render(createElement(ShareDialog, {
  project: current, projectId: current.id, open, onOpenChange, onMemberCountChange
})));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en"); onOpenChange.mockReset(); onMemberCountChange.mockReset(); directory = [...users];
  members = [{ ...users[1], permission: "read" }];
  vi.mocked(api).mockReset().mockImplementation(async (url, options) => {
    if (url === "/api/users") return { users: directory } as never;
    if (url.endsWith("/members") && !options?.method) return { members: [...members] } as never;
    throw new Error(`Unexpected request: ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("project share user combobox", () => {
  it("reports the shared member count without including an owner membership", async () => {
    members.push({ ...users[0], permission: "edit" });
    await render();
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(1);
    expect(onMemberCountChange).toHaveBeenLastCalledWith(project.id, 1);
  });

  it("opens the available-user list directly and distinguishes duplicate names without including owners or members", async () => {
    await render();
    expect(scope().querySelector(".share-user-modes")).toBeNull();
    expect(search().value).toBe(""); expect(search().getAttribute("aria-expanded")).toBe("false");
    expect(add().disabled).toBe(true); expect(permission().value).toBe("read");
    await click(search());
    expect(options().map((option) => option.textContent)).toEqual(["Alice Chen@alice.research", "同名用户@bob", "同名用户@carol"]);
    expect(document.activeElement).toBe(search()); expect(writes()).toHaveLength(0);
  });

  it("filters locally by display name or username and preserves the permission when replacing a selected user", async () => {
    await render(); await choosePermission("edit"); await click(search());
    await input(" ALICE CHEN ");
    expect(options().map((option) => option.textContent)).toEqual(["Alice Chen@alice.research"]);
    await input("@ALICE.RESEARCH"); expect(options()).toHaveLength(1);
    await click(options()[0]);
    expect(search().value).toBe("Alice Chen (@alice.research)");
    expect(add().disabled).toBe(false); expect(search().getAttribute("aria-expanded")).toBe("false");
    await chooseUser("bob"); expect(search().value).toBe("同名用户 (@bob)"); expect(permission().value).toBe("edit");
    expect(vi.mocked(api).mock.calls.filter(([url]) => url === "/api/users")).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("restores the full candidate list when the filter is cleared but never implicitly selects a user", async () => {
    await render(); await click(search()); await input("alice"); expect(options()).toHaveLength(1);
    for (const query of ["", "   ", " @ "]) {
      await input(query); expect(options()).toHaveLength(3); expect(add().disabled).toBe(true);
    }
    await input("("); expect(options()).toHaveLength(0);
    expect(search().hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.querySelector(".share-user-no-results")?.textContent).toBe("No matching users.");
  });

  it("clears stale selection when typing and selects only an explicitly chosen matching candidate", async () => {
    await render(); await chooseUser("alice");
    await input("no-such-user");
    expect(add().disabled).toBe(true); expect(options()).toHaveLength(0);
    await key(search(), "Enter"); expect(writes()).toHaveLength(0);
    await input("同名用户"); expect(options()).toHaveLength(2); expect(add().disabled).toBe(true);
    await click(options()[1]); expect(search().value).toBe("同名用户 (@carol)");
  });

  it("supports keyboard selection, composition and Escape without dismissing the share dialog", async () => {
    await render(); await click(search()); await input("同名用户");
    await key(search(), "ArrowDown");
    expect(document.getElementById(search().getAttribute("aria-activedescendant")!)?.textContent).toBe("同名用户@carol");
    await key(search(), "Enter", true); expect(add().disabled).toBe(true);
    await key(search(), "Enter"); expect(search().value).toBe("同名用户 (@carol)");
    expect(search().getAttribute("aria-expanded")).toBe("false");
    await click(search()); expect(options()).toHaveLength(3);
    expect(document.getElementById(search().getAttribute("aria-activedescendant")!)?.textContent).toBe("同名用户@carol");
    await key(search(), "Escape"); expect(document.querySelector(".share-user-popover")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    await key(search(), "Escape"); expect(onOpenChange).toHaveBeenCalledWith(false);
    await key(search(), "ArrowDown"); expect(options()).toHaveLength(3);
  });

  it("keeps users beyond the first screen selectable through the bounded list", async () => {
    directory = [users[0], ...Array.from({ length: 100 }, (_, index) => ({ id: `user-${index}`, username: `researcher${index}`, displayName: `Researcher ${index}` }))];
    await render(); await click(search()); expect(options()).toHaveLength(100);
    await key(search(), "ArrowUp");
    expect(document.getElementById(search().getAttribute("aria-activedescendant")!)?.textContent).toBe("Researcher 99@researcher99");
    await key(search(), "Enter"); expect(search().value).toBe("Researcher 99 (@researcher99)");
    expect(add().disabled).toBe(false); expect(writes()).toHaveLength(0);
  });

  it("adds the chosen user once with the chosen permission, then removes them from available candidates", async () => {
    await render(); await chooseUser("alice"); await choosePermission("edit");
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { add().click(); add().click(); });
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/projects/paper/members/alice");
    expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ permission: "edit" }); expect(search().disabled).toBe(true);
    members.push({ ...users[2], permission: "edit" });
    await act(async () => finish({ ok: true }));
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(2);
    expect(onMemberCountChange).toHaveBeenLastCalledWith(project.id, 2);
    expect(search().value).toBe(""); expect(add().disabled).toBe(true); expect(permission().value).toBe("read");
    await click(search()); expect(options().map((option) => option.textContent)).toEqual(["同名用户@bob", "同名用户@carol"]);
  });

  it("preserves the selection after failed sharing and supports retry without a false success", async () => {
    await render(); await chooseUser("bob"); await choosePermission("edit");
    vi.mocked(api).mockRejectedValueOnce(new Error("Sharing failed")); await click(add());
    expect(scope().querySelector('[role="alert"]')?.textContent).toBe("Sharing failed");
    expect(search().value).toBe("同名用户 (@bob)"); expect(permission().value).toBe("edit"); expect(add().disabled).toBe(false);
    members.push({ ...users[3], permission: "edit" }); vi.mocked(api).mockResolvedValueOnce({ ok: true });
    await click(add()); expect(scope().querySelector('[role="alert"]')).toBeNull();
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(2);
  });

  it("keeps sharing controls owner-only without requesting the user directory for readers", async () => {
    await render({ ...project, permission: "read" });
    expect(scope().querySelector(".share-add")).toBeNull();
    expect(scope().querySelector<HTMLSelectElement>(".member-controls select")?.disabled).toBe(true);
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).toEqual(["/api/projects/paper/members"]);
  });

  it("retains permission changes and reports removal errors inside confirmation before a successful retry", async () => {
    await render(); members[0] = { ...members[0], permission: "edit" }; vi.mocked(api).mockResolvedValueOnce({ ok: true });
    await act(async () => {
      const field = scope().querySelector<HTMLSelectElement>(".member-controls select")!;
      field.value = "edit"; field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ permission: "edit" });
    await click(scope().querySelector<HTMLButtonElement>('.member-controls [aria-label="Remove"]')!);
    vi.mocked(api).mockRejectedValueOnce(new Error("Removal failed"));
    await click(document.querySelector<HTMLButtonElement>(".dialog-footer button.danger")!);
    expect(document.querySelector(".dialog-error")?.textContent).toBe("Removal failed");
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(1);
    expect(onMemberCountChange).toHaveBeenLastCalledWith(project.id, 1);
    members = []; vi.mocked(api).mockResolvedValueOnce({ ok: true });
    await click(document.querySelector<HTMLButtonElement>(".dialog-footer button.danger")!);
    expect(document.querySelector(".dialog-error")).toBeNull();
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(0);
    expect(onMemberCountChange).toHaveBeenLastCalledWith(project.id, 0);
    await click(search()); expect(options().some((option) => option.textContent === "Current Member@existing")).toBe(true);
  });

  it("explains an empty directory without offering an invalid selection", async () => {
    members = users.slice(1).map((user) => ({ ...user, permission: "read" }));
    await render(); await click(search());
    expect(options()).toHaveLength(0); expect(add().disabled).toBe(true);
    expect(document.querySelector(".share-user-no-results")?.textContent).toBe("No users available to add.");
  });

  it("ignores late directory results from a previous project and resets its selection", async () => {
    let finishUsers!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(async () => ({ members: [] }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishUsers = resolve; }));
    await render(); const oldSignal = vi.mocked(api).mock.calls[0][1]!.signal!; expect(add().disabled).toBe(true);
    await render({ ...project, id: "second" }); expect(oldSignal.aborted).toBe(true); await chooseUser("carol");
    onMemberCountChange.mockClear();
    await act(async () => finishUsers({ users: [{ id: "stale", username: "stale" }] }));
    expect(onMemberCountChange).not.toHaveBeenCalled();
    expect(search().value).toBe("同名用户 (@carol)");
    await click(search()); expect(options().some((option) => option.textContent?.includes("stale"))).toBe(false);
    await render({ ...project, id: "second" }, false); await render({ ...project, id: "second" }); expect(search().value).toBe("");
  });

  it("does not let an old project's failed mutation unlock or overwrite a new project's pending share", async () => {
    await render(); await chooseUser("alice");
    let failOld!: (reason: Error) => void, finishNew!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; })); await click(add());
    await render({ ...project, id: "second" }); await chooseUser("bob"); await choosePermission("edit");
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; })); await click(add());
    await act(async () => failOld(new Error("Old project failed")));
    expect(scope().querySelector('[role="alert"]')).toBeNull(); expect(add().disabled).toBe(true);
    expect(search().value).toBe("同名用户 (@bob)"); expect(permission().value).toBe("edit");
    await click(add()); expect(writes()).toHaveLength(2);
    members.push({ ...users[3], permission: "edit" }); await act(async () => finishNew({ ok: true }));
    expect(scope().querySelectorAll(".shared-member")).toHaveLength(2);
    await click(search());
    expect(options().some((option) => option.textContent === "Alice Chen@alice.research")).toBe(true);
    expect(options().some((option) => option.textContent === "同名用户@bob")).toBe(false);
  });
});
