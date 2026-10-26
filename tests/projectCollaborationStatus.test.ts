// @vitest-environment happy-dom

import { EventEmitter } from "node:events";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ProjectCollaboration, SharedCompileState } from "../src/client/collaboration";
import { collaborationSaveState } from "../src/client/workspace/collaborationStatus";
import { useProjectCollaboration } from "../src/client/workspace/useProjectCollaboration";

function subscribe<T>(listeners: Set<T>, listener: T) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

class ControlledCollaboration {
  readonly doc = new Y.Doc();
  readonly provider = new EventEmitter();
  readonly awareness = new EventEmitter();
  readonly meta = this.doc.getMap("texlite:meta");
  readonly protocolListeners = new Set<() => void>();
  readonly permissionListeners = new Set<Parameters<ProjectCollaboration["onPermissionChanged"]>[0]>();
  readonly compileListeners = new Set<() => void>();
  readonly leaseListeners = new Set<() => void>();
  readonly draftListeners = new Set<() => void>();
  connected = false;
  synced = false;
  currentPermission = "edit";
  hasWritableDraft = false;
  hasOtherWritableDraft = false;
  readonly sessions = vi.fn<ProjectCollaboration["sessions"]>(() => []);
  readonly compileStates = vi.fn<ProjectCollaboration["compileStates"]>(() => ({}));
  readonly formatLeaseStates = vi.fn<ProjectCollaboration["formatLeaseStates"]>(() => []);
  readonly connect = vi.fn(() => this.transport("connecting"));
  readonly reconnect = vi.fn(() => {
    this.provider.emit("connection-close");
    this.transport("connecting");
  });
  readonly setPermission = (permission: string) => { this.currentPermission = permission; };
  readonly onCompileStates = (listener: () => void) => subscribe(this.compileListeners, listener);
  readonly onFormatLeaseState = (listener: () => void) => subscribe(this.leaseListeners, listener);
  readonly onDraftReady = (listener: () => void) => subscribe(this.draftListeners, listener);
  readonly onProtocolUpgrade = (listener: () => void) => subscribe(this.protocolListeners, listener);
  readonly onPermissionChanged = (listener: Parameters<ProjectCollaboration["onPermissionChanged"]>[0]) => subscribe(this.permissionListeners, listener);

  transport(status: "connecting" | "connected" | "disconnected") {
    this.connected = status === "connected";
    if (!this.connected) this.synced = false;
    this.provider.emit("status", { status });
  }

  synchronize(value: boolean) {
    this.synced = value;
    this.provider.emit("sync", value);
  }

  get client() { return this as unknown as ProjectCollaboration; }
}

let root: Root, container: HTMLDivElement, collaboration: ControlledCollaboration;
let current: ReturnType<typeof useProjectCollaboration>;
let ready: boolean;
const savedState = "editor.savedAt";

function Harness() {
  current = useProjectCollaboration(collaboration.client, "main.tex", "edit", ready);
  return createElement("output", null, collaborationSaveState(current.status, savedState, collaboration.hasWritableDraft));
}

async function render(nextReady = ready) {
  ready = nextReady;
  await act(async () => { root.render(createElement(Harness)); });
}

async function connect() {
  await act(async () => {
    collaboration.transport("connected");
    collaboration.synchronize(true);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  collaboration = new ControlledCollaboration();
  ready = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  collaboration.doc.destroy();
  container.remove();
  vi.unstubAllGlobals();
});

describe("workspace collaboration connection status", () => {
  it.each([true, false])("reads an existing provider's handshake state when subscribing (synced=%s)", async (synced) => {
    collaboration.connected = true;
    collaboration.synced = synced;
    await render();
    expect(current.status).toBe(synced ? "connected" : "syncing");
    expect(current.synced).toBe(synced);
    expect(collaboration.connect).not.toHaveBeenCalled();
  });

  it("does not call deferred startup or a pending document handshake offline", async () => {
    collaboration.hasWritableDraft = true;
    await render();
    expect(collaboration.connect).not.toHaveBeenCalled();
    expect(current.status).toBe("connecting");
    expect(container.textContent).toBe("editor.collaboration.connecting");
    await render(true);
    expect(collaboration.connect).toHaveBeenCalledOnce();
    expect(current.status).toBe("connecting");
    await act(async () => collaboration.transport("connected"));
    expect(current.status).toBe("syncing");
    expect(current.synced).toBe(false);
    expect(container.textContent).toBe("editor.collaboration.syncing");
    await act(async () => collaboration.synchronize(false));
    expect(current.status).toBe("syncing");
    await act(async () => collaboration.synchronize(true));
    expect(current.status).toBe("connected");
    expect(current.synced).toBe(true);
    expect(container.textContent).toBe(savedState);
    expect(collaboration.hasWritableDraft).toBe(true);
  });

  it.each(["connection-error", "connection-close"])("detects an initial %s even without a provider disconnected event", async (event) => {
    await render(true);
    await act(async () => { collaboration.provider.emit(event); });
    expect(current.status).toBe("disconnected");
    expect(current.synced).toBe(false);
    expect(container.textContent).toBe("editor.collaboration.disconnected");
  });

  it("detects an explicit transport disconnect even if no close or error event was observed", async () => {
    await render(true);
    await connect();
    await act(async () => collaboration.transport("disconnected"));
    expect(current.status).toBe("disconnected");
    expect(current.synced).toBe(false);
    expect(container.textContent).toBe("editor.collaboration.disconnected");
  });

  it("recovers the saved label after a genuine disconnect and an automatic retry without editing the document", async () => {
    collaboration.hasWritableDraft = true;
    collaboration.doc.getText("source:main.tex").insert(0, "Unsent draft");
    await render(true);
    await connect();
    await act(async () => {
      collaboration.provider.emit("connection-close");
      collaboration.transport("disconnected");
    });
    expect(current.status).toBe("disconnected");
    expect(current.synced).toBe(false);
    expect(container.textContent).toBe("editor.offlineDraft");
    await act(async () => collaboration.transport("connecting"));
    expect(current.status).toBe("connecting");
    expect(container.textContent).toBe("editor.collaboration.connecting");
    await act(async () => collaboration.transport("connected"));
    expect(current.status).toBe("syncing");
    expect(current.synced).toBe(false);
    await act(async () => collaboration.synchronize(true));
    expect(container.textContent).toBe(savedState);
    expect(collaboration.doc.getText("source:main.tex").toString()).toBe("Unsent draft");
    expect(collaboration.hasWritableDraft).toBe(true);
  });

  it("does not clear live metadata just because an open socket needs to synchronize again", async () => {
    const compile: SharedCompileState = {
      mainFile: "main.tex", runId: "run", status: "running",
      requestedBy: { id: "alice", username: "alice", name: "Alice" }, updatedAt: "2026-10-26T00:00:00Z"
    };
    collaboration.compileStates.mockReturnValue({ "main.tex": compile });
    collaboration.meta.set("commentsRevision", "revision");
    await render(true);
    await connect();
    expect(current.compileState).toEqual(compile);
    expect(current.commentsRevision).toBe("revision");
    await act(async () => collaboration.synchronize(false));
    expect(current.status).toBe("syncing");
    expect(current.synced).toBe(false);
    expect(current.compileState).toEqual(compile);
    expect(current.commentsRevision).toBe("revision");
    await act(async () => collaboration.provider.emit("connection-error"));
    expect(current.status).toBe("disconnected");
    expect(current.compileState).toBeNull();
    expect(current.commentsRevision).toBe("");
    await connect();
    expect(current.compileState).toEqual(compile);
    expect(current.commentsRevision).toBe("revision");
  });

  it("keeps a manual reconnect pending until the next handshake completes", async () => {
    await render(true);
    await connect();
    await act(async () => current.reconnect());
    expect(collaboration.reconnect).toHaveBeenCalledOnce();
    expect(current.status).toBe("connecting");
    expect(current.synced).toBe(false);
    await act(async () => collaboration.transport("connected"));
    expect(current.status).toBe("syncing");
    await act(async () => collaboration.synchronize(true));
    expect(current.status).toBe("connected");
  });

  it("marks revoked access unavailable and preserves the draft", async () => {
    collaboration.hasWritableDraft = true;
    await render(true);
    await connect();
    await act(async () => { for (const listener of collaboration.permissionListeners) listener("revoked", "edit"); });
    expect(current.status).toBe("disconnected");
    expect(current.synced).toBe(false);
    expect(collaboration.hasWritableDraft).toBe(true);
  });

  it("does not allow a reconnect to bypass a protocol upgrade and removes listeners on unmount", async () => {
    await render(true);
    await connect();
    await act(async () => { for (const listener of collaboration.protocolListeners) listener(); });
    expect(current.protocolUpgradeRequired).toBe(true);
    expect(current.status).toBe("disconnected");
    expect(current.synced).toBe(false);
    await act(async () => current.reconnect());
    expect(collaboration.reconnect).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(collaboration.provider.eventNames()).toEqual([]);
    expect(collaboration.awareness.eventNames()).toEqual([]);
    for (const listeners of [collaboration.protocolListeners, collaboration.permissionListeners,
      collaboration.compileListeners, collaboration.leaseListeners, collaboration.draftListeners]) {
      expect(listeners.size).toBe(0);
    }
  });
});

describe("connection labels over save progress", () => {
  it.each(["editor.saved", "editor.savedAt", "editor.pending", "editor.saving", "editor.saveFailed"])("restores %s when the document is ready", (saveState) => {
    expect(collaborationSaveState("connecting", saveState, true)).toBe("editor.collaboration.connecting");
    expect(collaborationSaveState("syncing", saveState, true)).toBe("editor.collaboration.syncing");
    expect(collaborationSaveState("disconnected", saveState, true)).toBe("editor.offlineDraft");
    expect(collaborationSaveState("disconnected", saveState, false)).toBe("editor.collaboration.disconnected");
    expect(collaborationSaveState("connected", saveState, false)).toBe(saveState);
  });
});
