// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { AdminUsers } from "../src/client/pages/AdminUsers";
import { CitationLibraryDialog } from "../src/client/CitationLibraryDialog";
import { CitationTagManagementDialog } from "../src/client/CitationTagManagementDialog";
import { GitHubAccountDialog } from "../src/client/GitHubAccountDialog";
import type { CitationLibraryEntry, User } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, footer, className }: { open: boolean; children: ReactNode; footer?: ReactNode; className?: string }) =>
    open ? createElement("section", { "data-test-modal": true, className }, children, footer) : null,
  ConfirmDialog: () => null
}));
const admin: User = { id: "admin", username: "admin", displayName: "Administrator", role: "admin", disabled: false,
  mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-28" };
const reader: User = { ...admin, id: "reader", username: "reader", displayName: "Reader", role: "user" };
const pagination = { page: 1, pageSize: 20, total: 2, totalPages: 1 };
let entry: CitationLibraryEntry;
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  entry = { id: "entry", ownerId: admin.id, ownerUsername: admin.username, ownerDisplayName: admin.displayName, citationKey: "sample", entryType: "article", title: "Paper", authors: "Ada", year: "2026",
    bibtex: "@article{sample, title={Paper}, author={Ada}, year={2026}}", tags: [], revision: 1, createdAt: "2026-10-28", updatedAt: "2026-10-28" };
  vi.mocked(api).mockReset().mockImplementation(async (url) => {
    if (url.startsWith("/api/admin/users?")) return { users: [admin, reader], pagination } as never;
    if (url.startsWith("/api/citations?")) return { entries: [entry], pagination: { ...pagination, total: 1 } } as never;
    if (url === "/api/citations/tags") return { tags: [] } as never;
    throw new Error(`Unexpected request: ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(element: ReactNode) {
  await act(async () => root.render(element));
  await act(async () => vi.advanceTimersByTime(0));
}
function changeText(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const click = (element: HTMLElement) => act(async () => element.click());
const assertNoBanner = () => expect(document.querySelector(".operation-success, .citation-library-notice, .admin-user-notice, .agent-inline-notice")).toBeNull();

describe("management action feedback", () => {
  it("confirms a validated GitHub token on its save button and keeps validation failures visible", async () => {
    vi.mocked(api).mockResolvedValueOnce({ status: { tokenConfigured: false, githubLogin: null } });
    await render(createElement(GitHubAccountDialog, { open: true, onOpenChange: vi.fn() }));
    await act(async () => changeText(host.querySelector<HTMLInputElement>('input[type="password"]')!, "example-personal-access-token"));
    const save = host.querySelector<HTMLButtonElement>(".save-button")!;
    vi.mocked(api).mockRejectedValueOnce(new Error("Invalid token"));
    await click(save);
    expect(host.querySelector(".dialog-error")?.textContent).toBe("Invalid token");
    expect(save.querySelector(".save-button-confirmation")).toBeNull();
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(save); await click(save);
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(2);
    expect(save.querySelector(".lucide-loader-circle")).not.toBeNull();
    await act(async () => finish({ status: { tokenConfigured: true, githubLogin: "researcher" } }));
    expect(save.textContent).toBe("Saved");
    expect(save.querySelector(".save-button-confirmation")).not.toBeNull();
    expect(host.querySelector(".git-account")?.textContent).toContain("researcher");
    expect(host.querySelector(".git-message.success")).toBeNull();
    assertNoBanner();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(save.textContent).toBe("Save and verify token");
  });

  it("shows password-reset success on the originating user's button, retaining errors on failure", async () => {
    await render(createElement(AdminUsers, { currentUser: admin, minPasswordLength: 8, onBack: vi.fn() }));
    expect(host.querySelector(".dashboard-back-button")?.textContent).toBe("Back to projects");
    const row = [...host.querySelectorAll("tbody tr")].find((element) => element.textContent?.includes("@reader"))!;
    const reset = row.querySelector<HTMLButtonElement>(".admin-user-actions button")!;
    await click(reset);
    await act(async () => changeText(host.querySelector<HTMLInputElement>(".password-generator input")!, "new-password"));
    vi.mocked(api).mockRejectedValueOnce(new Error("Reset rejected"));
    await click(host.querySelector<HTMLElement>('[data-test-modal] button.primary')!);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Reset rejected");
    expect(reset.textContent).toBe("Reset password");
    vi.mocked(api).mockResolvedValueOnce({ ok: true } as never);
    await click(host.querySelector<HTMLElement>('[data-test-modal] button.primary')!);
    expect(host.querySelector("[data-test-modal]")).toBeNull();
    expect(reset.textContent).toBe("Done");
    expect(host.querySelector("tbody tr .admin-user-actions button")?.textContent).toBe("Reset password");
    assertNoBanner();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(reset.textContent).toBe("Reset password");
  });

  it.each([true, false])("keeps a citation edit open and uses the new revision for the next save (page=%s)", async (page) => {
    await render(createElement(CitationLibraryDialog, { open: true, page, currentUserId: admin.id, maxBibtexBytes: 100_000,
      onOpenChange: vi.fn(), onBack: vi.fn() }));
    if (page) expect(host.querySelector(".dashboard-back-button")?.textContent).toBe("Back to projects");
    await act(async () => host.querySelector('[aria-haspopup="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Edit")!);
    const textarea = host.querySelector("textarea")!;
    const save = host.querySelector<HTMLButtonElement>(".citation-edit-panel .save-button")!;
    await act(async () => changeText(textarea, "@article{sample, title={New paper}}"));
    entry = { ...entry, revision: 2, title: "New paper", bibtex: textarea.value };
    vi.mocked(api).mockResolvedValueOnce({ entry });
    await click(save);
    expect(save.isConnected).toBe(true);
    expect(save.textContent).toBe("Saved");
    expect(save.querySelector(".save-button-confirmation")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(0)); // Refresh the saved metadata without remounting the form.
    expect(host.querySelector("textarea")).toBe(textarea);
    assertNoBanner();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(save.textContent).toBe("Save");
    vi.mocked(api).mockRejectedValueOnce(new Error("Citation conflict"));
    await click(save);
    const patches = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(patches.at(-1)![1]!.body as string).expectedRevision).toBe(2);
    expect(save.textContent).toBe("Save");
    expect(host.querySelector(".dialog-error")?.textContent).toBe("Citation conflict");
  });

  it("shows citation-tag save feedback in the still-open edit form rather than a banner", async () => {
    const tag = { id: "tag", ownerId: admin.id, name: "Old tag", color: "blue" as const };
    const updated = vi.fn();
    await render(createElement(CitationTagManagementDialog, { tags: [tag], onClose: vi.fn(), onUpdated: updated, onDeleted: vi.fn() }));
    await click(host.querySelector<HTMLElement>('[aria-label="Edit tag Old tag"]')!);
    await act(async () => changeText(host.querySelector<HTMLInputElement>(".tag-management-edit input")!, "New tag"));
    vi.mocked(api).mockResolvedValueOnce({ tag: { ...tag, name: "New tag" } });
    const save = host.querySelector<HTMLButtonElement>(".tag-management-edit .save-button")!;
    await click(save);
    expect(updated).toHaveBeenCalledWith({ ...tag, name: "New tag" });
    expect(save.textContent).toBe("Saved");
    assertNoBanner();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(save.textContent).toBe("Save");
  });

  it("does not reopen a citation editor closed while its save was pending", async () => {
    await render(createElement(CitationLibraryDialog, { open: true, page: true, currentUserId: admin.id, maxBibtexBytes: 100_000,
      onOpenChange: vi.fn() }));
    await act(async () => host.querySelector('[aria-haspopup="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Edit")!);
    let finish!: (value: { entry: CitationLibraryEntry }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(host.querySelector<HTMLElement>(".citation-edit-panel .save-button")!);
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    await click(host.querySelector<HTMLElement>(".citation-edit-actions button")!);
    expect(host.querySelector("textarea")).toBeNull();
    await act(async () => finish({ entry: { ...entry, revision: 2 } }));
    expect(host.querySelector("textarea")).toBeNull();
    assertNoBanner();
  });
});
