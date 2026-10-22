// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import type { FileEntry, SiteConfig } from "../src/client/types";
import { useProjectFiles } from "../src/client/workspace/useProjectFiles";
import "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

const site = { maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 5 } as SiteConfig;
const text: FileEntry = { path: "notes.txt", type: "file", size: 100 };
let files: ReturnType<typeof useProjectFiles>;
let root: Root;
let host: HTMLDivElement;
let unmounted: boolean;
const onError = vi.fn();
const onActiveFile = vi.fn();

function Harness() {
  const [activeFile, setActiveFile] = useState("main.tex");
  files = useProjectFiles({ projectId: "project", site, activeFile, dirty: false, save: async () => true,
    onError, onProject: vi.fn(), onActiveFile: (value) => { onActiveFile(value); setActiveFile(value); }, onActiveMainFile: vi.fn() });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset(); onError.mockReset(); onActiveFile.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); unmounted = false;
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

describe("opening suffix-classified project files", () => {
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
