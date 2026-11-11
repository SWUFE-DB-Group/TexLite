// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/client/api";
import { HistoryDialog } from "../src/client/HistoryDialog";
import { SelectionHistoryDialog } from "../src/client/SelectionHistoryDialog";
import type { HistoryVersion, Project } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? createElement("div", null, children, createElement("div", { className: "dialog-footer" }, footer)) : null,
  ConfirmDialog: ({ open, title, onCancel }: { open: boolean; title: string; onCancel: () => void }) => open
    ? createElement("div", { role: "alertdialog" }, createElement("strong", null, title), createElement("button", { onClick: onCancel }, "Cancel"))
    : null
}));

const project: Project = {
  id: "paper", ownerId: "author", lastModifiedBy: null, name: "Paper", mainFile: "main.tex",
  latexmkrc: null, engine: "pdflatex", icon: null, chktexEnabled: false, permission: "read", tags: [],
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
};
const version: HistoryVersion = {
  id: "snapshot", snapshotHash: "hash", reason: "autosave", label: null,
  author: { id: "author", name: "Administrator", username: "admin" }, hasAgent: false,
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
  it.each(["read", "edit", "owner"] as const)("groups snapshot actions without an empty operation row (%s)", async (permission) => {
    vi.mocked(api)
      .mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
      .mockResolvedValueOnce({ version, settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [{ path: "main.tex", size: 3 }] })
      .mockResolvedValueOnce({ path: "main.tex", historical: "New", comparison: "Old", against: "__previous__", previousVersion: null });
    const onBeforeMutation = vi.fn(async () => true);
    await act(async () => root.render(createElement(HistoryDialog, {
      open: true, project: { ...project, permission }, onOpenChange: () => {}, onBeforeMutation
    })));
    const restore = host.querySelector<HTMLButtonElement>(".history-restore-project");
    const actions = host.querySelector(".history-snapshot-actions");
    expect(Boolean(host.querySelector(".history-delete-action"))).toBe(permission === "owner");
    expect(Boolean(actions)).toBe(permission === "owner");
    expect(Boolean(restore)).toBe(permission !== "read");
    if (!restore) return;
    expect(host.querySelectorAll(".history-restore-project")).toHaveLength(1);
    expect(restore.disabled).toBe(false);
    expect(restore.closest(permission === "owner" ? ".history-snapshot-actions" : ".history-detail-header")).not.toBeNull();
    if (actions) expect(actions.firstElementChild?.className).toBe("history-delete-action");
    const requests = vi.mocked(api).mock.calls.length;
    await act(async () => restore.click());
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(i18n.t("history.restoreProjectTitle"));
    expect(onBeforeMutation).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(requests);
  });

  it("shows snapshots saved while the dialog is open and reloads a selected snapshot that grew", async () => {
    vi.useFakeTimers();
    try {
      const grown = { ...version, snapshotHash: "grown", changedPaths: ["main.tex", "refs.bib"] };
      const newer = { ...version, id: "newer", createdAt: "2026-01-01T12:05:00Z", reason: "file" as const };
      const detail = (snapshot: HistoryVersion) => ({ version: snapshot, settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null },
        files: [{ path: "main.tex", size: 3 }, { path: "refs.bib", size: 3 }] });
      vi.mocked(api).mockImplementation(async (url: string) => {
        if (url.includes("/history?")) return (vi.mocked(api).mock.calls.filter(([call]) => String(call).includes("/history?")).length > 1
          ? { versions: [newer, grown], stats: null, nextCursor: null }
          : { versions: [version], stats: null, nextCursor: null }) as never;
        if (url.includes("/file?")) return { path: "main.tex", historical: "New", comparison: "Old", against: "__previous__", previousVersion: null } as never;
        return detail(vi.mocked(api).mock.calls.filter(([call]) => String(call).endsWith("/history/snapshot")).length > 1 ? grown : version) as never;
      });
      await act(async () => root.render(createElement(HistoryDialog, { open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true })));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(host.querySelectorAll(".history-timeline > button")).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
      expect(host.querySelectorAll(".history-timeline > button")).toHaveLength(2);
      // The selection stays on the snapshot the user was reading, now with its new files.
      expect(host.querySelector(".history-timeline > button.active")?.textContent).not.toContain(i18n.t("history.reasons.file"));
      expect([...host.querySelectorAll(".history-file-list button")].map((node) => node.textContent)).toEqual(["main.tex", "refs.bib"]);
    } finally { vi.useRealTimers(); }
  });

  it.each([0, 2])("keeps the compact edit-history clear action owner-only and disabled for an empty history (%i)", async (count) => {
    vi.mocked(api)
      .mockResolvedValueOnce({ segmentCount: count, payloadBytes: 1024, maxStorageBytes: 32 * 1048576 })
      .mockResolvedValueOnce({ entries: [], baseline: null, chainComplete: true, hasMore: false });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project: { ...project, permission: "owner" }, filePath: "main.tex",
      selection: { selectedText: "New", startOffset: 0, endOffset: 3 }, currentSource: "New", onOpenChange: () => {}
    })));
    const button = host.querySelector<HTMLButtonElement>(".selection-history-clear")!;
    expect(button.closest(".dialog-footer")).not.toBeNull();
    expect(button.textContent).toBe(i18n.t("selectionHistory.clearAll"));
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.disabled).toBe(count === 0);
  });

  it("shows each edit-history author's display name with a username tooltip, including same-name coauthors", async () => {
    vi.mocked(api).mockResolvedValue({
      entries: [{ id: "edit", filePath: "main.tex", createdAt: version.createdAt, updatedAt: version.createdAt,
        authors: [{ ...version.author, avatarStyle: "lorelei" }, { id: "second", name: "Administrator", username: "other-admin" },
          { id: "legacy", name: null, username: "legacy" }, { id: null, name: null, username: null }],
        content: "New", contentTruncated: false }],
      baseline: null, chainComplete: true, hasMore: false
    });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
      currentSource: "New", onOpenChange: () => {}
    })));
    const authors = host.querySelectorAll(".selection-history-author-list > span");
    expect([...authors].map((node) => node.querySelector(".selection-history-author-name")?.textContent)).toEqual(["Administrator", "Administrator", "legacy", i18n.t("editor.deletedUser")]);
    expect(host.querySelector(".selection-history-authors > svg")).toBeNull();
    expect(host.querySelector(".selection-history-authors")?.firstElementChild?.textContent).toBe(i18n.t("selectionHistory.changedBy"));
    expect(authors[0].firstElementChild?.classList.contains("selection-history-avatar")).toBe(true);
    expect(authors[0].querySelector("img")?.getAttribute("src")).toBe("/api/users/author/avatar.svg?style=lorelei&v=2");
    expect(authors[1].querySelector(".selection-history-avatar")?.textContent).toBe("A");
    expect(authors[3].querySelector("img")).toBeNull();
    expect([...authors].map((node) => node.getAttribute("data-tooltip"))).toEqual(["@admin", "@other-admin", "@legacy", null]);
    expect(authors[0].hasAttribute("data-texlite-tooltip-always")).toBe(true);
    expect(host.textContent).not.toContain("@admin");
    expect(host.querySelector(".selection-history-clear")).toBeNull();
  });

  it("loads older edits after the shown ones and keeps the comparison chain joined", async () => {
    await i18n.changeLanguage("en");
    const entry = (id: string, content: string) => ({ id, filePath: "main.tex", createdAt: version.createdAt, updatedAt: version.createdAt,
      authors: [version.author], content, contentTruncated: false });
    vi.mocked(api)
      .mockResolvedValueOnce({ entries: [entry("e3", "New"), entry("e2", "Mid")], baseline: { content: "Old", contentTruncated: false }, chainComplete: true, hasMore: true })
      .mockResolvedValueOnce({ entries: [entry("e1", "Old")], baseline: { content: "First", contentTruncated: false }, chainComplete: false, hasMore: false });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
      currentSource: "New", onOpenChange: () => {}
    })));
    const more = host.querySelector<HTMLButtonElement>(".selection-history-load-more button")!;
    expect(more.textContent).toBe("Load older edits");
    await act(async () => more.click());
    expect(new URL(String(vi.mocked(api).mock.calls[1]![0]), "http://x").searchParams.get("offset")).toBe("2");
    expect([...host.querySelectorAll(".selection-history-content pre")].map((node) => node.textContent)).toEqual(["New", "Mid", "Old"]);
    expect(host.querySelector(".selection-history-load-more")).toBeNull();
    expect(host.querySelector(".selection-history-boundary")?.textContent).toBe(i18n.t("selectionHistory.boundary"));
  });

  it("asks once more when the server has not yet received the edits made just before opening", async () => {
    vi.useFakeTimers();
    try {
      const changed = new ApiError("changed", 409, "SELECTION_HISTORY_SOURCE_CHANGED");
      vi.mocked(api)
        .mockRejectedValueOnce(changed)
        .mockResolvedValueOnce({ entries: [], baseline: null, chainComplete: true, hasMore: false });
      await act(async () => root.render(createElement(SelectionHistoryDialog, {
        open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
        currentSource: "New", onOpenChange: () => {}
      })));
      expect(host.querySelector(".selection-history-message")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(api).toHaveBeenCalledTimes(2);
      expect(host.querySelector(".selection-history-message")).toBeNull();
      expect(host.querySelector(".selection-history-empty")).not.toBeNull();

      // A second conflict means the source really changed, so it is shown.
      await act(async () => root.unmount());
      root = createRoot(host);
      vi.mocked(api).mockReset().mockRejectedValue(changed);
      await act(async () => root.render(createElement(SelectionHistoryDialog, {
        open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
        currentSource: "New", onOpenChange: () => {}
      })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(api).toHaveBeenCalledTimes(2);
      expect(host.querySelector(".selection-history-message")?.textContent).toBe("changed");
    } finally { vi.useRealTimers(); }
  });

  it("adds Coding Agent after the authors of an edit-history entry that includes agent edits", async () => {
    vi.mocked(api).mockResolvedValue({
      entries: [{ id: "edit", filePath: "main.tex", createdAt: version.createdAt, updatedAt: version.createdAt,
        authors: [version.author], hasAgent: true, content: "New", contentTruncated: false }],
      baseline: null, chainComplete: true, hasMore: false
    });
    await act(async () => root.render(createElement(SelectionHistoryDialog, {
      open: true, project, filePath: "main.tex", selection: { selectedText: "New", startOffset: 0, endOffset: 3 },
      currentSource: "New", onOpenChange: () => {}
    })));
    const authors = [...host.querySelectorAll(".selection-history-author-list > span")];
    expect(authors.map((node) => node.querySelector(".selection-history-author-name")?.textContent)).toEqual(["Administrator", "Coding Agent"]);
    expect(authors[1].classList.contains("selection-history-agent")).toBe(true);
    expect(authors[1].querySelector(".selection-history-avatar svg")).not.toBeNull();
  });

  it.each([
    ["en", { ...version, hasAgent: true }, "Administrator, Coding Agent"],
    ["zh", { ...version, hasAgent: true }, "Administrator、Coding Agent"],
    ["en", { ...version, author: null, hasAgent: true }, "Multiple authors, Coding Agent"]
  ] as const)("names Coding Agent after the snapshot author (%s, %j)", async (language, agentVersion, label) => {
    await i18n.changeLanguage(language);
    vi.mocked(api)
      .mockResolvedValueOnce({ versions: [agentVersion], stats: null, nextCursor: null })
      .mockResolvedValueOnce({ version: agentVersion, settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [{ path: "main.tex", size: 3 }] })
      .mockResolvedValueOnce({ path: "main.tex", historical: "New", comparison: "Old", against: "__previous__", previousVersion: null });
    await act(async () => root.render(createElement(HistoryDialog, {
      open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true
    })));
    expect(host.querySelector(".history-author-name")?.textContent).toBe(label);
    expect(host.querySelector(".history-snapshot-attribution strong")?.textContent).toBe(label);
  });

  it("folds a run of automatic saves under a day header and opens it for the selected snapshot", async () => {
    await i18n.changeLanguage("en");
    const saves = [3, 2, 1].map((minute) => ({ ...version, id: `save-${minute}`, createdAt: `2026-01-01T12:0${minute}:00Z` }));
    const named = { ...version, id: "named", reason: "file" as const, label: "Submitted", createdAt: "2026-01-01T11:00:00Z" };
    vi.mocked(api).mockImplementation(async (url: string) => (url.includes("/history?")
      ? { versions: [...saves, named], stats: null, nextCursor: null }
      : { version: saves[0], settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [] }) as never);
    await act(async () => root.render(createElement(HistoryDialog, {
      open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true
    })));
    const run = () => host.querySelector<HTMLButtonElement>(".history-autosave-run")!;
    expect(host.querySelectorAll(".history-day")).toHaveLength(1);
    expect(run().textContent).toContain("3 automatic saves");
    // The newest snapshot is selected, so its run starts open.
    expect(run().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".history-grouped")).toHaveLength(3);
    await act(async () => run().click());
    expect(run().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll(".history-grouped")).toHaveLength(0);
    // A collapsed run that holds the selection is marked, and named snapshots stay visible.
    expect(run().classList.contains("active")).toBe(true);
    expect(host.textContent).toContain("Submitted");
  });

  it("leaves a collapsed run collapsed when older snapshots are loaded", async () => {
    await i18n.changeLanguage("en");
    const saves = [3, 2, 1].map((minute) => ({ ...version, id: `save-${minute}`, createdAt: `2026-01-01T12:0${minute}:00Z` }));
    const older = { ...version, id: "older", reason: "file" as const, createdAt: "2026-01-01T11:00:00Z" };
    vi.mocked(api).mockImplementation(async (url: string) => (url.includes("before=")
      ? { versions: [older], stats: null, nextCursor: null }
      : url.includes("/history?")
        ? { versions: saves, stats: null, nextCursor: "next" }
        : { version: saves[0], settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [] }) as never);
    await act(async () => root.render(createElement(HistoryDialog, {
      open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true
    })));
    const run = () => host.querySelector<HTMLButtonElement>(".history-autosave-run")!;
    expect(run().getAttribute("aria-expanded")).toBe("true");
    await act(async () => run().click());
    await act(async () => host.querySelector<HTMLButtonElement>(".history-load-more button")!.click());
    expect(host.textContent).toContain(i18n.t("history.reasons.file"));
    expect(run().getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["en", "zh"])("limits snapshot attribution to version metadata and keeps username tooltips in the timeline (%s)", async (language) => {
    await i18n.changeLanguage(language);
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
    expect(host.querySelector(".history-commit-author")).toBeNull();
    expect(host.querySelector(".history-snapshot-attribution > span")?.textContent).toBe(i18n.t("history.lastChangedBy"));
    expect(host.querySelector(".history-snapshot-attribution strong")?.textContent).toBe("Administrator");
    expect(host.querySelector(".history-snapshot-time time")?.getAttribute("datetime")).toBe(version.createdAt);
    expect(host.querySelector(".history-snapshot-file-count")?.textContent).toBe(language === "en" ? "1 file" : "1 个文件");
    expect(host.querySelector(".history-comparison")?.textContent).not.toContain("Administrator");
    expect(host.querySelector(".history-detail-header [data-tooltip]")).toBeNull();
    expect(host.textContent).not.toContain("@admin");
  });

  it("shows the snapshot origin instead of implying an author when a shared autosave has no attribution", async () => {
    const sharedVersion = { ...version, author: null };
    vi.mocked(api)
      .mockResolvedValueOnce({ versions: [sharedVersion], stats: null, nextCursor: null })
      .mockResolvedValueOnce({ version: sharedVersion, settings: { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null }, files: [{ path: "main.tex", size: 3 }] })
      .mockResolvedValueOnce({ path: "main.tex", historical: "New", comparison: "Old", against: "__previous__", previousVersion: null });
    await act(async () => root.render(createElement(HistoryDialog, { open: true, project, onOpenChange: () => {}, onBeforeMutation: async () => true })));
    expect(host.querySelector(".history-snapshot-attribution")).toBeNull();
    expect(host.querySelector(".history-snapshot-origin")?.textContent).toBe(i18n.t("history.reasons.autosave"));
  });
});
