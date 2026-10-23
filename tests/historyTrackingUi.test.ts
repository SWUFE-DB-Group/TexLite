// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { HistoryFilesManager } from "../src/client/HistoryFilesManager";
import { HistoryDialog } from "../src/client/HistoryDialog";
import type { HistoryTrackedFile } from "../src/shared/historyTracking";
import type { Project } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? createElement("div", null, children, createElement("div", { className: "dialog-footer" }, footer)) : null,
  ConfirmDialog: () => null
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

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
