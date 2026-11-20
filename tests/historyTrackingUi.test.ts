// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/client/api";
import { HistoryFilesManager } from "../src/client/HistoryFilesManager";
import { HistoryDialog } from "../src/client/HistoryDialog";
import i18n from "../src/client/i18n";
import type { HistoryTrackedFile } from "../src/shared/historyTracking";
import type { HistoryVersion, HistoryVersionDetail, Project } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? createElement("div", null, children, createElement("div", { className: "dialog-footer" }, footer)) : null,
  ConfirmDialog: ({ open, title, description, confirmLabel, onConfirm }: {
    open: boolean; title: string; description: string; confirmLabel: string; onConfirm: () => void;
  }) => open ? createElement("div", { role: "alertdialog" },
    createElement("h2", null, title), createElement("p", null, description),
    createElement("button", { onClick: onConfirm }, confirmLabel)) : null
}));

const files: HistoryTrackedFile[] = [
  { path: "main.tex", size: 10, included: true, override: null, defaultIncluded: true, missing: false },
  { path: "figure.pdf", size: 100, included: false, override: null, defaultIncluded: false, missing: false }
];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps failed choices unchecked, reports the error in the manager, and prevents duplicate saves", async () => {
  const onSaved = vi.fn();
  vi.mocked(api).mockResolvedValueOnce({ files });
  await act(async () => root.render(createElement(HistoryFilesManager, { open: true, projectId: "p", onOpenChange: vi.fn(), onSaved })));
  expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => input.checked)).toEqual([true, false]);
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const pdf = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
  await act(async () => { pdf.click(); pdf.click(); });
  expect(api).toHaveBeenCalledTimes(2);
  expect(pdf.disabled).toBe(true);
  await act(async () => reject(new Error("Save failed")));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
  expect(pdf.checked).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValueOnce({ files: [files[0], { ...files[1], included: true, override: true }] });
  await act(async () => pdf.click());
  expect(api).toHaveBeenLastCalledWith("/api/projects/p/history/files", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ path: "figure.pdf", included: true }) }));
  expect(pdf.checked).toBe(true);
  expect(onSaved).toHaveBeenCalledOnce();
});

it.each(["read", "edit", "owner"] as const)("only shows snapshot file management to writers (%s)", async (permission) => {
  vi.mocked(api).mockResolvedValue({ versions: [], stats: null, nextCursor: null });
  const project = { id: "p", permission } as Project;
  await act(async () => root.render(createElement(HistoryDialog, { open: true, project, onOpenChange: vi.fn(), onBeforeMutation: async () => true })));
  expect(host.querySelector(".dialog-footer .history-manage-files") !== null).toBe(permission !== "read");
});

it.each([".gitignore", "build.bat", "scripts/RUN.CMD", "settings.ini", "notes.custom"])("renders recorded text diffs and permits switching comparison modes (%s)", async (filePath) => {
  const version: HistoryVersion = {
    id: "v", snapshotHash: "a".repeat(64), reason: "file", label: null,
    createdAt: "2026-10-24T00:00:00Z", author: null, hasAgent: false, changedPaths: [filePath], fileCount: 1, totalSize: 12
  };
  vi.mocked(api)
    .mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
    .mockResolvedValueOnce({ version, files: [{ path: filePath, size: 12, textContent: true }], settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null } })
    .mockResolvedValue({ path: filePath, historical: "*.aux\n*.log\n", comparison: "*.aux\n", against: "previous", previousVersion: null });
  await act(async () => root.render(createElement(HistoryDialog, { open: true, project: { id: "p", permission: "read" } as Project, onOpenChange: vi.fn(), onBeforeMutation: async () => true })));
  expect(api).toHaveBeenLastCalledWith(`/api/projects/p/history/v/file?path=${encodeURIComponent(filePath)}&against=__previous__`, expect.anything());
  expect(host.querySelector(".history-no-text-diff")).toBeNull();
  expect(host.querySelector(".history-git-diff")?.textContent).toContain("+*.log");

  const currentMode = host.querySelectorAll<HTMLButtonElement>(".history-mode-toggle button")[1];
  await act(async () => currentMode.click());
  expect(api).toHaveBeenLastCalledWith(`/api/projects/p/history/v/file?path=${encodeURIComponent(filePath)}`, expect.anything());
  expect(host.querySelector(".history-git-diff")?.textContent).toContain("-*.log");
});

it.each(["file", "project"] as const)("confirms and restores the intended scope (%s) when the path is named project", async (scope) => {
  const filePath = "project";
  const snapshotHash = "a".repeat(64);
  const version: HistoryVersion = { id: "v", snapshotHash, reason: "file", label: null,
    createdAt: "2026-10-24T00:00:00Z", author: null, hasAgent: false, changedPaths: [filePath], fileCount: 1, totalSize: 3 };
  vi.mocked(api)
    .mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
    .mockResolvedValueOnce({ version, scoped: true, files: [{ path: filePath, size: 3, textContent: true }] })
    .mockResolvedValueOnce({ path: filePath, historical: "New", comparison: "Old", against: "__previous__", previousVersion: null })
    .mockResolvedValueOnce({ ok: true });
  vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const onBeforeMutation = vi.fn(async () => true);
  await act(async () => root.render(createElement(HistoryDialog, {
    open: true, project: { id: "p", permission: "owner" } as Project, onOpenChange: vi.fn(), onBeforeMutation
  })));
  const trigger = host.querySelector<HTMLButtonElement>(scope === "file" ? ".history-file-actions button" : ".history-restore-project")!;
  await act(async () => trigger.click());
  const confirm = host.querySelector('[role="alertdialog"]')!;
  expect(confirm.querySelector("h2")?.textContent).toBe(i18n.t(scope === "file" ? "history.restoreFileTitle" : "history.restoreProjectTitle"));
  expect(confirm.querySelector("p")?.textContent).toBe(scope === "file"
    ? i18n.t("history.restoreFileDescription", { path: filePath }) : i18n.t("history.restoreTrackedDescription"));
  expect(onBeforeMutation).not.toHaveBeenCalled();
  await act(async () => confirm.querySelector("button")!.click());
  expect(onBeforeMutation).toHaveBeenCalledOnce();
  expect(api).toHaveBeenLastCalledWith("/api/projects/p/history/v/restore", {
    method: "POST", body: JSON.stringify(scope === "file" ? { path: filePath, snapshotHash } : { snapshotHash })
  });
});

it.each(["figures/Diagram.DRAWIO", "refs.bib"])("waits for the selected snapshot before comparing %s", async (filePath) => {
  const first: HistoryVersion = { id: "v1", snapshotHash: "a".repeat(64), reason: "file", label: "First snapshot",
    createdAt: "2026-10-24T00:00:00Z", author: null, hasAgent: false, changedPaths: ["main.tex"], fileCount: 1, totalSize: 3 };
  const second: HistoryVersion = { ...first, id: "v2", snapshotHash: "b".repeat(64), label: "Second snapshot",
    createdAt: "2026-10-23T00:00:00Z", changedPaths: [filePath] };
  const detail = (version: HistoryVersion): HistoryVersionDetail => ({
    version, files: version.changedPaths.map((path) => ({ path, size: 3, textContent: true })),
    settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }
  });
  let resolveSecond!: (value: HistoryVersionDetail) => void;
  const secondDetail = new Promise<HistoryVersionDetail>((resolve) => { resolveSecond = resolve; });
  const diff = (path: string) => ({ path, historical: "New", comparison: "Old", against: "__previous__", previousVersion: null });
  vi.mocked(api)
    .mockResolvedValueOnce({ versions: [first, second], stats: null, nextCursor: null })
    .mockResolvedValueOnce(detail(first))
    .mockResolvedValueOnce(diff("main.tex"))
    .mockImplementation(async (url) => {
      if (url === "/api/projects/p/history/v2") return await secondDetail as never;
      if (url === `/api/projects/p/history/v2/file?path=${encodeURIComponent(filePath)}&against=__previous__`) return diff(filePath) as never;
      throw new ApiError("File not found in this snapshot", 404, "HISTORY_FILE_NOT_FOUND");
    });
  await act(async () => root.render(createElement(HistoryDialog, { open: true, project: { id: "p", permission: "edit" } as Project, onOpenChange: vi.fn(), onBeforeMutation: async () => true })));
  expect(host.querySelector(".history-git-diff")?.textContent).toContain("+New");
  const next = [...host.querySelectorAll<HTMLButtonElement>(".history-timeline > button")].find((button) => button.textContent?.includes("Second snapshot"))!;
  await act(async () => next.click());
  expect(api).toHaveBeenLastCalledWith("/api/projects/p/history/v2", expect.anything());
  expect(host.querySelector(".history-file-list button")).toBeNull();
  await act(async () => resolveSecond(detail(second)));
  expect(host.querySelector(".history-message")).toBeNull();
  expect(host.querySelector(".history-file-list button")?.textContent).toBe(filePath);
  if (filePath === "refs.bib") {
    expect(api).toHaveBeenLastCalledWith("/api/projects/p/history/v2/file?path=refs.bib&against=__previous__", expect.anything());
    expect(host.querySelector(".history-git-diff")?.textContent).toContain("+New");
  } else {
    expect(api).toHaveBeenCalledTimes(4);
    expect(host.querySelector(".history-no-text-diff")?.textContent).toBe(i18n.t("history.diagramNoDiff"));
  }
});

it.each([
  ["binary.bat", false, false, "history.nonTextNoDiff"],
  ["figure.pdf", false, true, "history.fileDeleted"],
  ["figures/Diagram.DRAWIO", true, false, "history.diagramNoDiff"],
  ["figures/Diagram.DRAWIO", true, true, "history.fileDeleted"]
] as const)("summarizes non-comparable changes (%s, text: %s, deleted: %s)", async (filePath, textContent, deleted, message) => {
  const version: HistoryVersion = { id: "v", snapshotHash: "a".repeat(64), reason: "file", label: null,
    createdAt: "2026-10-24T00:00:00Z", author: null, hasAgent: false, changedPaths: [filePath], fileCount: deleted ? 0 : 1, totalSize: deleted ? 0 : 128 };
  vi.mocked(api)
    .mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
    .mockResolvedValueOnce({ version, files: [{ path: filePath, size: version.totalSize, textContent, deleted }] });
  await act(async () => root.render(createElement(HistoryDialog, { open: true, project: { id: "p", permission: "edit" } as Project, onOpenChange: vi.fn(), onBeforeMutation: async () => true })));
  expect(api).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".history-file-list button")?.textContent).toContain(filePath);
  const notice = host.querySelector(".history-no-text-diff");
  expect(notice?.querySelector("svg[aria-hidden]")).toBeTruthy();
  expect(notice?.textContent).toBe(i18n.t(message));
  expect(host.querySelector(".history-mode-toggle")).toBeNull();
  expect(host.querySelector<HTMLButtonElement>(".history-file-actions button")?.disabled).toBe(deleted);
});
