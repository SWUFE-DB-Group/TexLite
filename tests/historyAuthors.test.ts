// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { HistoryDialog } from "../src/client/HistoryDialog";
import { SelectionHistoryDialog } from "../src/client/SelectionHistoryDialog";
import type { HistoryVersion, Project } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", null, children) : null,
  ConfirmDialog: () => null
}));

const project: Project = {
  id: "paper", ownerId: "author", lastModifiedBy: null, name: "Paper", mainFile: "main.tex",
  latexmkrc: null, engine: "pdflatex", icon: null, chktexEnabled: false, permission: "read", tags: [],
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
};
const version: HistoryVersion = {
  id: "snapshot", snapshotHash: "hash", reason: "autosave", label: null,
  author: { id: "author", name: "Administrator", username: "admin" },
  createdAt: "2026-01-01T12:00:00Z", changedPaths: ["main.tex"], fileCount: 1, totalSize: 3
};
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("history author identities", () => {
  it.each([0, 2])("keeps the compact edit-history clear action owner-only and disabled for an empty history (%i)", async (count) => {
    vi.mocked(api)
      .mockResolvedValueOnce({ segmentCount: count, payloadBytes: 1024, maxStorageBytes: 32 * 1048576 })
      .mockResolvedValueOnce({ entries: [], baseline: null, chainComplete: true, hasMore: false });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project: { ...project, permission: "owner" }, filePath: "main.tex",
      selection: { selectedText: "New", startOffset: 0, endOffset: 3 }, currentSource: "New", onOpenChange: () => {}
    })));
    const button = host.querySelector<HTMLButtonElement>(".selection-history-clear")!;
    expect(button.textContent).toBe(i18n.t("selectionHistory.clearAll"));
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.disabled).toBe(count === 0);
  });

  it("shows each edit-history author's display name with a username tooltip, including same-name coauthors", async () => {
    vi.mocked(api).mockResolvedValue({
      entries: [{ id: "edit", filePath: "main.tex", createdAt: version.createdAt, updatedAt: version.createdAt,
        authors: [version.author, { id: "second", name: "Administrator", username: "other-admin" },
          { id: "legacy", name: null, username: "legacy" }, { id: null, name: null, username: null }],
        content: "New", contentTruncated: false }],
      baseline: null, chainComplete: true, hasMore: false
    });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
      currentSource: "New", onOpenChange: () => {}
    })));
    const authors = host.querySelectorAll(".selection-history-author-list > span");
    expect([...authors].map((node) => node.textContent)).toEqual(["Administrator", "Administrator", "legacy", i18n.t("editor.deletedUser")]);
    expect([...authors].map((node) => node.getAttribute("data-tooltip"))).toEqual(["@admin", "@other-admin", "@legacy", null]);
    expect(authors[0].hasAttribute("data-texlite-tooltip-always")).toBe(true);
    expect(host.textContent).not.toContain("@admin");
    expect(host.querySelector(".selection-history-clear")).toBeNull();
  });

  it("limits snapshot username tooltips to timeline authors without altering inline layout", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
      .mockResolvedValueOnce({ version, settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [{ path: "main.tex", size: 3 }] })
      .mockResolvedValueOnce({ path: "main.tex", historical: "New", comparison: "Old", against: "__previous__", previousVersion: null });
    await act(async () => root.render(createElement(HistoryDialog, {
      open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true
    })));
    const authors = host.querySelectorAll('[data-tooltip="@admin"]');
    expect(authors).toHaveLength(1);
    for (const author of authors) {
      expect(author.textContent).toBe("Administrator");
      expect(author.hasAttribute("data-texlite-tooltip-always")).toBe(true);
    }
    expect(host.querySelector(".history-author-name")?.parentElement?.tagName).toBe("SMALL");
    expect(host.querySelector(".history-commit-author")?.hasAttribute("data-tooltip")).toBe(false);
    expect(host.querySelector(".history-detail-header [data-tooltip]")).toBeNull();
    expect(host.textContent).not.toContain("@admin");
  });
});
