// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import { clearDocument } from "y-indexeddb";
import { ProjectCollaboration, writableDraftAvailability, writableDraftCoveredByFlush } from "../src/client/collaboration";
import { clearCollaborationDraftCache } from "../src/client/collaborationDraftCache";
import type { User } from "../src/client/types";
import { COLLABORATION_PROTOCOL_VERSION, CollaborationMessageType } from "../src/shared/collaborationProtocol";

const cachedDocuments = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock("../src/client/collaborationDraftCache", () => ({
  clearCollaborationDraftCache: vi.fn(async (_persistence, prepare) => prepare())
}));

vi.mock("y-indexeddb", () => ({
  clearDocument: vi.fn(async () => {}),
  IndexeddbPersistence: class {
    readonly destroy = vi.fn(async () => { this.doc.off("update", this.store); });
    private synced?: () => void;
    private readonly store = () => cachedDocuments.set(this.name, Y.encodeStateAsUpdate(this.doc));
    constructor(readonly name: string, private readonly doc: Y.Doc) { doc.on("update", this.store); }
    on(_event: string, listener: () => void) { this.synced = listener; }
    hydrate() {
      const saved = cachedDocuments.get(this.name);
      if (saved) Y.applyUpdate(this.doc, saved);
      this.synced?.();
    }
  }
}));

const user: User = {
  id: "writer", username: "writer", displayName: "Writer", role: "user",
  disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: ""
};
const epochKey = "texlite:collaboration-epoch:writer:project";
const markerKeys = () => Object.keys(localStorage).filter((key) => key.startsWith("texlite:collaboration-writable:"));
const sessions: ProjectCollaboration[] = [];

function openProject() {
  const session = new ProjectCollaboration("project", user);
  session.setPermission("edit");
  sessions.push(session);
  return session;
}

function receive(session: ProjectCollaboration, type: number, packet: encoding.Encoder) {
  const handler = session.provider.messageHandlers[type];
  handler(encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(packet)), session.provider, true, type);
}

function prepareFlush(session: ProjectCollaboration) {
  const send = vi.fn<(bytes: Uint8Array) => void>();
  Object.assign(session.provider, { ws: { readyState: WebSocket.OPEN, send, close() {} }, synced: true });
  const pending = session.flush();
  const bytes = send.mock.lastCall![0];
  const request = decoding.createDecoder(bytes);
  expect(decoding.readVarUint(request)).toBe(CollaborationMessageType.Flush);
  const receipt = encoding.createEncoder();
  encoding.writeVarString(receipt, decoding.readVarString(request));
  encoding.writeVarUint(receipt, 1);
  encoding.writeVarUint(receipt, 2);
  encoding.writeVarString(receipt, "2026-11-22T00:00:00.000Z");
  encoding.writeVarUint(receipt, 0);
  return { pending, acknowledge: () => receive(session, CollaborationMessageType.Flush, receipt) };
}

function deferredDeletion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
  localStorage.clear();
  sessionStorage.clear();
  cachedDocuments.clear();
  vi.mocked(clearCollaborationDraftCache).mockReset();
  vi.mocked(clearDocument).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("client collaboration draft generations", () => {
  it("clears a marker only when the flush covers every current local edit", () => {
    expect(writableDraftCoveredByFlush(3, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(2, 3, 3)).toBe(true);
    expect(writableDraftCoveredByFlush(4, 4, 3)).toBe(false);
    expect(writableDraftCoveredByFlush(3, 4, 3)).toBe(false);
  });

  it("distinguishes live tabs from recoverable inactive drafts", () => {
    const now = 1_000_000;
    expect(writableDraftAvailability([
      { tabId: "current", activeAt: now }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: now }
    ], "current", now)).toEqual({ recoverable: false, otherActive: true });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: 0 }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
    expect(writableDraftAvailability([
      { tabId: "other", activeAt: 1 }
    ], "current", now)).toEqual({ recoverable: true, otherActive: false });
  });

  it("keeps recovery available while another live tab temporarily blocks deletion", () => {
    const now = 200_000;
    expect(writableDraftAvailability([
      { tabId: "current", activeAt: now },
      { tabId: "other", activeAt: now }
    ], "current", now)).toEqual({ recoverable: true, otherActive: true });
  });
});

describe("collaboration in the browser", () => {
  it("does not let a flush in the original tab clear the duplicated tab's offline draft", async () => {
    sessionStorage.setItem("texlite:collaboration-tab:writer:project", "copied-session-storage");
    const original = openProject();
    original.getText("main.tex").insert(0, "Saved from the first tab");
    const flush = prepareFlush(original);
    const duplicate = openProject();
    duplicate.getText("main.tex").insert(0, "Unsaved in the second tab");
    expect(markerKeys()).toHaveLength(2);

    flush.acknowledge();
    await flush.pending;
    original.setPermission("read");
    duplicate.setPermission("read");
    expect(original.hasWritableDraft).toBe(false);
    expect(original.hasOtherWritableDraft).toBe(true);
    expect(await original.discardLocalDraft()).toBe(false);
    expect(clearCollaborationDraftCache).not.toHaveBeenCalled();
    expect(duplicate.hasWritableDraft).toBe(true);
    expect(duplicate.getText("main.tex").toString()).toBe("Unsaved in the second tab");
  });

  it("only clears recovered markers after a flush sent after IndexedDB hydration", async () => {
    const first = openProject();
    first.getText("main.tex").insert(0, "Offline edit");
    first.destroy();
    const refreshed = openProject();
    const beforeHydration = prepareFlush(refreshed);
    (refreshed.persistence as unknown as { hydrate(): void }).hydrate();
    beforeHydration.acknowledge();
    await beforeHydration.pending;
    expect(refreshed.hasRecoveredWritableDraft).toBe(true);
    expect(markerKeys()).toHaveLength(1);
    const afterHydration = prepareFlush(refreshed);
    afterHydration.acknowledge();
    await afterHydration.pending;
    expect(refreshed.hasWritableDraft).toBe(false);
    expect(markerKeys()).toHaveLength(0);
  });

  it("protects a clean tab and rechecks for new tabs before clearing", async () => {
    const session = openProject();
    session.setPermission("read");
    const cleanPeer = openProject();
    expect(await session.discardLocalDraft()).toBe(false);
    expect(clearCollaborationDraftCache).not.toHaveBeenCalled();
    cleanPeer.destroy();

    const startTransaction = deferredDeletion();
    vi.mocked(clearCollaborationDraftCache).mockImplementationOnce(async (_persistence, prepare) => {
      await startTransaction.promise;
      return prepare();
    });
    const pending = session.discardLocalDraft();
    const newPeer = openProject();
    newPeer.getText("main.tex").insert(0, "Draft created while cleanup waited");
    startTransaction.resolve();
    expect(await pending).toBe(false);
    expect(newPeer.hasWritableDraft).toBe(true);
    expect(session.persistence.destroy).not.toHaveBeenCalled();
  });

  it("keeps the draft until cleanup commits and restores persistence after a rollback", async () => {
    const session = openProject();
    session.getText("main.tex").insert(0, "Local draft");
    session.setPermission("read");
    const initialPersistence = session.persistence;
    vi.mocked(clearCollaborationDraftCache).mockImplementationOnce(async (_persistence, prepare) => {
      expect(prepare()).toBe(true);
      throw new Error("IndexedDB error");
    });
    await expect(session.discardLocalDraft()).rejects.toThrow("IndexedDB error");
    expect(session.hasWritableDraft).toBe(true);
    expect(initialPersistence.destroy).toHaveBeenCalledOnce();
    expect(session.persistence).not.toBe(initialPersistence);
    session.setPermission("edit");
    session.applyTextEdits("main.tex", [{ from: 11, to: 11, replacement: " and more" }]);
    session.destroy();
    const reopened = openProject();
    (reopened.persistence as unknown as { hydrate(): void }).hydrate();
    expect(reopened.getText("main.tex").toString()).toBe("Local draft and more");
    reopened.setPermission("read");

    const deletion = deferredDeletion();
    vi.mocked(clearCollaborationDraftCache).mockImplementationOnce(async (_persistence, prepare) => {
      expect(prepare()).toBe(true);
      await deletion.promise;
      return true;
    });
    const retry = reopened.discardLocalDraft();
    expect(reopened.hasWritableDraft).toBe(true);
    deletion.resolve();
    await expect(retry).resolves.toBe(true);
    expect(reopened.hasWritableDraft).toBe(false);
  });

  it("does not acknowledge a new source epoch or reload until IndexedDB cleanup succeeds", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const oldEpoch = `${COLLABORATION_PROTOCOL_VERSION}:old`;
    const newEpoch = `${COLLABORATION_PROTOCOL_VERSION}:new`;
    localStorage.setItem(epochKey, oldEpoch);
    const session = openProject();
    session.getText("main.tex").insert(0, "Old source");
    const onFailure = vi.fn();
    session.onDraftResetFailure(onFailure);
    vi.mocked(clearDocument).mockRejectedValueOnce(new Error("IndexedDB error"));
    const packet = encoding.createEncoder();
    encoding.writeVarString(packet, newEpoch);
    receive(session, CollaborationMessageType.Protocol, packet);
    await vi.waitFor(() => expect(onFailure).toHaveBeenLastCalledWith(true));
    expect(localStorage.getItem(epochKey)).toBe(oldEpoch);
    expect(session.hasWritableDraft).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    const deletion = deferredDeletion();
    vi.mocked(clearDocument).mockReturnValueOnce(deletion.promise);
    session.reconnect();
    await vi.waitFor(() => expect(clearDocument).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem(epochKey)).toBe(oldEpoch);
    expect(reload).not.toHaveBeenCalled();
    deletion.resolve();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(localStorage.getItem(epochKey)).toBe(newEpoch);
    expect(session.hasWritableDraft).toBe(false);
  });

  it("shows and expires a remote formatting lease using elapsed time despite a skewed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-22T12:30:00.000Z"));
    const session = openProject();
    const packet = encoding.createEncoder();
    for (const field of ["state", "", "main.tex", "", String(Date.now() - 30 * 60_000 + 30_000), "", "other", "Other writer"]) {
      encoding.writeVarString(packet, field);
    }
    encoding.writeVarUint(packet, 30_000);
    const onChange = vi.fn();
    session.onFormatLeaseState(onChange);
    receive(session, CollaborationMessageType.FormatLease, packet);
    vi.setSystemTime(new Date("2026-11-22T16:30:00.000Z"));
    vi.advanceTimersByTime(29_999);
    expect(session.formatLeaseStates()).toMatchObject([{ path: "main.tex", holderName: "Other writer" }]);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(session.formatLeaseStates()).toEqual([]);
  });
});
