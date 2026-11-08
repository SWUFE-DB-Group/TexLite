// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GitDialog } from "../src/client/GitDialog";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { Project } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) => open ? createElement("section", { className }, children) : null
}));
let root: Root, host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("toggles the current diff without refetching on close, refreshes on reopen and switches cleanly from a commit diff", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const commit = { sha: "abc", shortSha: "abc", message: "Earlier version", authorName: "Author", authoredAt: "2026-11-01" };
  let content = "+First change";
  vi.mocked(api).mockImplementation(async (url) => {
    if (url.endsWith("/history")) return { commits: [commit] };
    if (url.includes("/diff")) return { title: "Changes", diff: url.includes("revision=") ? "+Historical change" : content, truncated: false };
    return { status: { initialized: true, tokenConfigured: false, latestCommit: commit, branch: "main", dirty: true, ahead: 0, restorable: true,
      commitIdentity: { name: "admin", email: "admin@texlite.com" } } };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const flush = vi.fn(async () => true);
  await act(async () => root.render(createElement(GitDialog, { open: true, project: { id: "project", name: "Paper" } as Project,
    onBeforeMutation: flush, onOpenChange: vi.fn() })));
  expect(host.querySelector(".git-identity-line")?.textContent).toBe("Commits use admin <admin@texlite.com>");
  expect(host.querySelector(".git-identity-name")?.textContent).toBe("admin");
  expect(host.querySelector(".git-identity-email")?.textContent).toBe("admin@texlite.com");
  const current = () => [...host.querySelectorAll<HTMLButtonElement>(".git-action-row button")].find(button => button.textContent === i18n.t("git.workingDiff"))!;
  const click = (button: HTMLButtonElement) => act(async () => button.click());
  const requests = () => vi.mocked(api).mock.calls.filter(([url]) => url.includes("/diff")).length;
  expect(current().querySelector(".lucide-eye")).not.toBeNull();
  await click(current());
  expect(current().getAttribute("aria-pressed")).toBe("true");
  expect(current().querySelector(".lucide-eye-off")).not.toBeNull();
  expect(host.querySelector(".git-diff")?.textContent).toContain("First change");
  const beforeClose = requests(), beforeFlush = flush.mock.calls.length;
  await click(current());
  expect(host.querySelector(".git-diff-section")).toBeNull();
  expect(current().getAttribute("aria-pressed")).toBe("false");
  expect(requests()).toBe(beforeClose); expect(flush).toHaveBeenCalledTimes(beforeFlush);
  content = "+Updated change";
  await click(current());
  expect(host.querySelector(".git-diff")?.textContent).toContain("Updated change");
  const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await click(tabs[1]);
  expect(host.querySelector(".git-action-row, .git-diff-section")).toBeNull();
  await click(host.querySelector<HTMLButtonElement>(".git-history button")!);
  expect(host.querySelector(".git-diff")?.textContent).toContain("Historical change");
  await click(tabs[0]);
  expect(host.querySelector(".git-history, .git-diff-section")).toBeNull();
  expect(current().getAttribute("aria-pressed")).toBe("false");
  await click(current());
  expect(host.querySelector(".git-diff")?.textContent).toContain("Updated change");
  await click(host.querySelector<HTMLButtonElement>(".git-diff-fullscreen")!);
  expect(host.querySelector(".git-dialog-modal-fullscreen")).not.toBeNull();
  await click(current());
  expect(host.querySelector(".git-diff-section, .git-dialog-modal-fullscreen")).toBeNull();
});
