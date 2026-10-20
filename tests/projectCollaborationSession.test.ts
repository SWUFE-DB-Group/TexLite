// @vitest-environment happy-dom

import { act, createElement, StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCollaboration } from "../src/client/collaboration";
import "../src/client/i18n";
import type { Project, User } from "../src/client/types";
import { ProjectCollaborationSession } from "../src/client/workspace/ProjectCollaborationSession";
import { useProjectCollaboration } from "../src/client/workspace/useProjectCollaboration";

interface TestSession {
  projectId: string;
  userId: string;
  destroyed: boolean;
  connect: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  listenersAtDestroy: number;
  doc: { guid: string };
}

const instances = vi.hoisted(() => [] as TestSession[]);
vi.mock("../src/client/collaboration", async () => {
  const { EventEmitter } = await import("node:events");
  const { Doc } = await import("yjs");
  return {
    ProjectCollaboration: class {
      readonly doc = new Doc();
      readonly provider = new EventEmitter();
      readonly awareness = new EventEmitter();
      readonly meta = this.doc.getMap("texlite:meta");
      readonly userId: string;
      connected = false;
      synced = false;
      destroyed = false;
      listenersAtDestroy = -1;
      currentPermission: Project["permission"] = "read";
      readonly hasWritableDraft = false;
      readonly hasOtherWritableDraft = false;
      private readonly listeners = new Set<() => void>();

      constructor(readonly projectId: string, user: User) {
        this.userId = user.id;
        instances.push(this);
      }
      sessions = () => [];
      compileStates = () => ({});
      formatLeaseStates = () => [];
      setPermission = (permission: Project["permission"]) => { this.currentPermission = permission; };
      onCompileStates = (listener: () => void) => this.subscribe(listener);
      onProtocolUpgrade = (listener: () => void) => this.subscribe(listener);
      onFormatLeaseState = (listener: () => void) => this.subscribe(listener);
      onDraftReady = (listener: () => void) => this.subscribe(listener);
      onPermissionChanged = (listener: () => void) => this.subscribe(listener);
      private subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      }
      connect = vi.fn(() => {
        if (this.destroyed) throw new Error("Connected a destroyed session");
        this.connected = true;
        this.synced = true;
        this.provider.emit("status", { status: "connected" });
        this.provider.emit("sync", true);
      });
      reconnect = vi.fn(() => this.connect());
      destroy = vi.fn(() => {
        this.listenersAtDestroy = this.listeners.size
          + this.provider.eventNames().reduce((count, name) => count + this.provider.listenerCount(name), 0)
          + this.awareness.listenerCount("change");
        this.destroyed = true;
        this.doc.destroy();
      });
    }
  };
});

const user: User = {
  id: "alice", username: "alice", displayName: "Alice", role: "user",
  disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-21T00:00:00Z"
};
const effectSetup = vi.fn();
const effectCleanup = vi.fn();

function Editor({ collaboration, ready, permission }: {
  collaboration: ProjectCollaboration;
  ready: boolean;
  permission: Project["permission"];
}) {
  const state = useProjectCollaboration(collaboration, "main.tex", permission, ready, () => {});
  const [draft, setDraft] = useState("");
  useEffect(() => { effectSetup(); return effectCleanup; }, []);
  return createElement("section", { "data-session": collaboration.doc.guid },
    createElement("output", null, `${state.status}:${state.synced}:${state.permission}`),
    createElement("button", { onClick: () => setDraft("Unsent comment draft") }, draft || "Compose"),
    createElement("button", { onClick: state.reconnect }, "Reconnect"));
}

let root: Root | null;
let container: HTMLDivElement;
let seen: string[];

async function render({ projectId = "paper", currentUser = user, ready = true, permission = "edit" }: {
  projectId?: string;
  currentUser?: User;
  ready?: boolean;
  permission?: Project["permission"];
} = {}) {
  await act(async () => {
    root!.render(createElement(StrictMode, null,
      createElement(ProjectCollaborationSession, {
        projectId, user: currentUser,
        children: (collaboration) => {
          seen.push(collaboration.doc.guid);
          return createElement(Editor, { collaboration, ready, permission });
        }
      })));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  instances.length = 0;
  seen = [];
  effectSetup.mockClear();
  effectCleanup.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); root = null; });
  container.remove();
  vi.unstubAllGlobals();
});

describe("collaboration session ownership", () => {
  it("does not create browser resources or render an editor before its effect runs", () => {
    const children = vi.fn(() => createElement("div", null, "Editor"));
    const html = renderToStaticMarkup(createElement(StrictMode, null,
      createElement(ProjectCollaborationSession, { projectId: "paper", user, children })));
    expect(instances).toHaveLength(0);
    expect(children).not.toHaveBeenCalled();
    expect(html).toContain('role="status"');
  });

  it("survives real StrictMode effect replay and connects a single live session", async () => {
    await render();
    expect(effectSetup).toHaveBeenCalledTimes(2);
    expect(effectCleanup).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(instances[0].connect).toHaveBeenCalled();
    expect(instances[0].destroy).not.toHaveBeenCalled();
    expect(container.querySelector("output")?.textContent).toBe("connected:true:edit");
  });

  it("waits for PDF readiness and keeps the same session and draft across ordinary updates", async () => {
    await render({ ready: false });
    const first = instances[0];
    expect(first.connect).not.toHaveBeenCalled();
    await act(async () => { container.querySelector("button")!.click(); });
    await render({ ready: true, permission: "read", currentUser: { ...user } });
    expect(instances).toHaveLength(1);
    expect(first.connect).toHaveBeenCalled();
    expect(first.destroy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsent comment draft");
    expect(container.querySelector("output")?.textContent).toBe("connected:true:read");
    await act(async () => { container.querySelectorAll("button")[1].click(); });
    expect(first.reconnect).toHaveBeenCalledTimes(1);
    expect(container.querySelector("section")?.dataset.session).toBe(first.doc.guid);
  });

  it("isolates projects and users and never renders the old session under a new identity", async () => {
    await render();
    const first = instances[0];
    seen = [];
    await render({ projectId: "appendix" });
    const second = instances[1];
    expect(seen).not.toContain(first.doc.guid);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.projectId).toBe("appendix");
    expect(second.destroy).not.toHaveBeenCalled();
    seen = [];
    await render({ projectId: "appendix", currentUser: { ...user, id: "bob", username: "bob" } });
    expect(seen).not.toContain(second.doc.guid);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(3);
    expect(instances[2].userId).toBe("bob");
    expect(instances[2].destroy).not.toHaveBeenCalled();
  });

  it("releases resources exactly once after subscriptions unmount and creates a fresh session on return", async () => {
    await render();
    const first = instances[0];
    await act(async () => { root!.render(null); });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(first.listenersAtDestroy).toBe(0);
    expect(container.querySelector("section")).toBeNull();
    await render();
    expect(instances).toHaveLength(2);
    expect(instances[1].doc.guid).not.toBe(first.doc.guid);
    expect(instances[1].destroy).not.toHaveBeenCalled();
    expect(container.querySelector("output")?.textContent).toBe("connected:true:edit");
  });
});
