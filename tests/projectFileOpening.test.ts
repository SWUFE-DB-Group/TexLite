// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import type { FileEntry, SiteConfig } from "../src/client/types";
import { useProjectFiles } from "../src/client/workspace/useProjectFiles";
import { prepareDrawioEditor } from "../src/client/workspace/drawioLoader";
import { DRAWIO_LOCK_HEADER } from "../src/shared/drawio";
import "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/workspace/drawioLoader", () => ({ prepareDrawioEditor: vi.fn() }));

const site = { maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 5 } as SiteConfig;
const text: FileEntry = { path: "notes.txt", type: "file", size: 100 };
let files: ReturnType<typeof useProjectFiles>;
let root: Root;
let host: HTMLDivElement;
let unmounted: boolean;
const onError = vi.fn();
const onActiveFile = vi.fn();
const onDrawioOpen = vi.fn();
const beforeOpenFile = vi.fn(async () => true);
const getDrawioLockToken = vi.fn<() => string | undefined>();

function Harness() {
  const [activeFile, setActiveFile] = useState("main.tex");
  files = useProjectFiles({ projectId: "project", site, activeFile, dirty: false, save: async () => true,
    onError, onProject: vi.fn(), beforeOpenFile, getDrawioLockToken, onDrawioOpen, onActiveFile: (value) => { onActiveFile(value); setActiveFile(value); }, onActiveMainFile: vi.fn() });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset(); onError.mockReset(); onActiveFile.mockReset(); onDrawioOpen.mockReset();
  beforeOpenFile.mockReset().mockResolvedValue(true);
  getDrawioLockToken.mockReset();
  vi.mocked(prepareDrawioEditor).mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); unmounted = false;
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

describe("opening suffix-classified project files", () => {
  it("deletes the active diagram with its lease, preserving the editor until deletion succeeds", async () => {
    const diagram: FileEntry = { path: "figures/diagram.drawio", type: "file", size: 100 };
    await act(async () => files.openFile(diagram));
    await act(async () => files.setDeleteEntry(diagram));
    beforeOpenFile.mockClear();
    getDrawioLockToken.mockReturnValue("current-lease");
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Unavailable", 503));
    await act(async () => files.removePath());
    expect(files.drawioPath).toBe(diagram.path);
    expect(files.deleteEntry).toBe(diagram);
    expect(files.fileDialogError).toBeTruthy();

    let finish!: (value: object) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { void files.removePath(); void files.removePath(); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith("/api/projects/project/file?path=figures%2Fdiagram.drawio", {
      method: "DELETE", headers: { [DRAWIO_LOCK_HEADER]: "current-lease" }
    });
    expect(files.deletingPath).toBe(true);
    expect(files.drawioPath).toBe(diagram.path);
    await act(async () => finish({ ok: true }));
    expect(files.drawioPath).toBeNull();
    expect(files.selectedFile).toBe("main.tex");
    expect(files.deleteEntry).toBeNull();
    expect(beforeOpenFile).not.toHaveBeenCalled();
  });

  it("keeps the diagram and its close guard untouched while previewing resources", async () => {
    await act(async () => files.openFile({ path: "diagram.drawio", type: "file", size: 100 }));
    beforeOpenFile.mockClear();
    for (const path of ["figure.pdf", "image.png", "archive.zip", "custom.unknown", "large.txt"]) {
      await act(async () => files.openFile({ path, type: "file", size: path === "large.txt" ? 6 * 1024 * 1024 : 100 }));
      expect(files.drawioPath).toBe("diagram.drawio");
      expect(files.resourcePreview?.path).toBe(path);
      expect(files.selectedFile).toBe(path);
      await act(async () => files.setResourcePreview(null));
      expect(files.drawioPath).toBe("diagram.drawio");
      await act(async () => files.openFile({ path: "diagram.drawio", type: "file", size: 100 }));
      expect(files.selectedFile).toBe("diagram.drawio");
    }
    expect(beforeOpenFile).not.toHaveBeenCalled();
    expect(onActiveFile).not.toHaveBeenCalled();
  });

  it("retains the diagram when a candidate text file fails validation or turns out to be binary", async () => {
    await act(async () => files.openFile({ path: "diagram.drawio", type: "file", size: 100 }));
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Not text", 400, "FILE_CONTENT_INVALID"));
    await act(async () => files.openFile(text));
    expect(files.drawioPath).toBe("diagram.drawio");
    expect(files.resourcePreview?.kind).toBe("unsupported");
    expect(onActiveFile).not.toHaveBeenCalled();
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Unavailable", 503));
    await act(async () => files.openFile(text));
    expect(files.drawioPath).toBe("diagram.drawio");
    expect(onError).toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce({ path: text.path });
    await act(async () => files.openFile(text));
    expect(files.drawioPath).toBeNull();
    expect(files.resourcePreview).toBeNull();
    expect(onActiveFile).toHaveBeenCalledWith(text.path);
  });

  it("keeps an unsaved diagram selected until file navigation is confirmed", async () => {
    await act(async () => files.openFile({ path: "diagram.drawio", type: "file", size: 100 }));
    beforeOpenFile.mockResolvedValueOnce(false);
    await act(async () => files.openFile(text));
    expect(files.drawioPath).toBe("diagram.drawio"); expect(files.selectedFile).toBe("diagram.drawio");
    expect(onActiveFile).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce({ path: text.path });
    await act(async () => files.openFile(text));
    expect(files.drawioPath).toBeNull(); expect(onActiveFile).toHaveBeenCalledWith(text.path);
  });

  it("opens diagrams in the visual editor without switching the source file, and keeps size/binary restrictions", async () => {
    beforeOpenFile.mockResolvedValueOnce(false);
    await act(async () => files.openFile({ path: "figures/flow.drawio", type: "file", size: 100 }));
    expect(files.drawioPath).toBeNull(); expect(onDrawioOpen).not.toHaveBeenCalled();
    expect(prepareDrawioEditor).not.toHaveBeenCalled();
    await act(async () => files.openFile({ path: "figures/flow.drawio", type: "file", size: 100 }));
    expect(files.drawioPath).toBe("figures/flow.drawio");
    expect(onDrawioOpen).toHaveBeenCalledOnce();
    expect(prepareDrawioEditor).toHaveBeenCalledOnce();
    expect(onActiveFile).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    await act(async () => files.setDrawioPath(null));
    await act(async () => files.openFile({ path: "large.drawio", type: "file", size: 6 * 1024 * 1024 }));
    expect(files.drawioPath).toBeNull(); expect(files.resourcePreview?.kind).toBe("large");
    await act(async () => files.openFile({ path: "invalid.drawio", type: "file", size: 10, textContent: false }));
    expect(files.drawioPath).toBeNull(); expect(files.resourcePreview?.kind).toBe("unsupported");
    expect(onDrawioOpen).toHaveBeenCalledOnce();
    expect(prepareDrawioEditor).toHaveBeenCalledOnce();
  });

  it("validates only the selected text file before activating its shared editor", async () => {
    expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce({ path: text.path });
    await act(async () => files.openFile(text));
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/project/file?path=notes.txt&validate=1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(onActiveFile).toHaveBeenCalledExactlyOnceWith(text.path);
    expect(files.resourcePreview).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps unknown types, known binaries and oversized text downloadable without a content request", async () => {
    for (const entry of [
      { ...text, path: "custom.unknown" }, { ...text, path: "archive.zip" }, { ...text, size: 6 * 1024 * 1024 }
    ]) {
      await act(async () => files.openFile(entry));
      expect(files.resourcePreview).toMatchObject({ path: entry.path,
        kind: entry.path === text.path ? "large" : "unsupported" });
    }
    expect(api).not.toHaveBeenCalled();
    expect(onActiveFile).not.toHaveBeenCalled();
  });

  it("does not activate an empty Yjs editor for a binary file disguised as text", async () => {
    await act(async () => files.setFiles([text]));
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Invalid text", 400, "FILE_CONTENT_INVALID"));
    await act(async () => files.openFile(text));
    expect(onActiveFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(files.resourcePreview).toMatchObject({ path: text.path, kind: "unsupported" });
    expect(files.files[0].textContent).toBe(false);
    await act(async () => files.openFile(files.files[0]));
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("ignores stale validation when a different resource is selected", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let opening!: Promise<void>;
    await act(async () => { opening = files.openFile(text); });
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    await act(async () => files.openFile({ ...text, path: "figure.png" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ path: text.path }); await opening; });
    expect(onActiveFile).not.toHaveBeenCalled();
    expect(files.selectedFile).toBe("figure.png");
    expect(files.resourcePreview).toMatchObject({ path: "figure.png", kind: "image" });
  });

  it.each(["folder", "unmount"])("cancels validation after %s without reporting an error", async (departure) => {
    let fail!: (error: Error) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    let opening!: Promise<void>;
    await act(async () => { opening = files.openFile(text); });
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    await act(async () => {
      if (departure === "folder") files.setSelectedFolder("chapters");
      else { root.unmount(); unmounted = true; }
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => { fail(new Error("Late network failure")); await opening; });
    expect(onError).not.toHaveBeenCalled();
    expect(onActiveFile).not.toHaveBeenCalled();
  });

  it("retains the current editor on a validation transport failure", async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Network unavailable", 0, "NETWORK_ERROR"));
    await act(async () => files.openFile(text));
    expect(onActiveFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith("Network unavailable");
  });

  it("also validates a newly uploaded text candidate before automatically opening it", async () => {
    vi.mocked(api).mockResolvedValueOnce({ path: text.path })
      .mockResolvedValueOnce({ files: [text] })
      .mockRejectedValueOnce(new ApiError("Invalid text", 400, "FILE_CONTENT_INVALID"));
    await act(async () => files.uploadFiles([new File([new Uint8Array([0, 255])], text.path)]));
    expect(api).toHaveBeenCalledTimes(3);
    expect(onActiveFile).not.toHaveBeenCalled();
    expect(files.resourcePreview).toMatchObject({ path: text.path, kind: "unsupported" });
    expect(files.uploadFeedback).toMatchObject({ kind: "success", count: 1 });
  });
});
