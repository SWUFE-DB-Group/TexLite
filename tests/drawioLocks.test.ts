import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawioLocks, DRAWIO_LOCK_TTL_MS, DRAWIO_LOCK_PING_MS } from "../src/server/drawioLocks";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn(); ping = vi.fn();
  terminate = vi.fn(() => { this.readyState = 3; this.emit("close"); });
  close = vi.fn(() => { this.readyState = 3; this.emit("close"); });
  get token(): string { return JSON.parse(this.send.mock.calls[0][0]).token; }
}
let locks: DrawioLocks;
const acquire = (socket = new Socket(), file = "figure.drawio", user = "u1", valid = () => true) => {
  locks.acquire("project", file, user, user, socket as unknown as WebSocket, valid); return socket;
};
beforeEach(() => { vi.useFakeTimers(); locks = new DrawioLocks(); });
afterEach(() => { locks.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe("draw.io exclusive edit leases", () => {
  it("allows one connection per file, including for the same user, and fences HTTP mutations with its token", () => {
    const first = acquire(), duplicate = acquire();
    expect(JSON.parse(duplicate.send.mock.calls[0][0])).toEqual({ type: "busy", name: "u1" });
    expect(() => locks.assertOwned("project", "figure.drawio", first.token, "u1")).not.toThrow();
    for (const [token, user] of [[undefined, "u1"], ["forged", "u1"], [first.token, "u2"]]) {
      expect(() => locks.assertOwned("project", "figure.drawio", token, user!)).toThrow(expect.objectContaining({ code: "DRAWIO_LOCK_LOST" }));
    }
    expect(acquire(new Socket(), "other.drawio").token).not.toBe(first.token);
    for (const candidate of ["figure.drawio", "figure.pdf"]) expect(() => locks.assertUnlocked("project", [candidate])).toThrow();
    expect(() => locks.assertUnlocked("project", ["main.tex", "other.pdfx"])).not.toThrow();
    expect(() => locks.assertUnlocked("elsewhere", ["figure.drawio"])).not.toThrow();
  });

  it.each(["close", "error", "release"])("releases on %s, and a late old close/release cannot unlock the successor", (event) => {
    const first = acquire();
    if (event === "release") first.emit("message", Buffer.from("release")); else first.emit(event, new Error("fixture"));
    const next = acquire(); expect(next.token).toBeTypeOf("string");
    first.emit("close"); first.emit("message", Buffer.from("release")); first.emit("pong");
    expect(() => locks.assertOwned("project", "figure.drawio", next.token, "u1")).not.toThrow();
    expect(() => locks.assertOwned("project", "figure.drawio", first.token, "u1")).toThrow();
  });

  it("renews with protocol pongs, but expires silent peers without relying on browser JavaScript timers", () => {
    const socket = acquire();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(DRAWIO_LOCK_PING_MS); socket.emit("pong"); }
    expect(socket.ping).toHaveBeenCalledTimes(5);
    expect(() => locks.assertOwned("project", "figure.drawio", socket.token, "u1")).not.toThrow();
    vi.advanceTimersByTime(DRAWIO_LOCK_TTL_MS);
    expect(socket.terminate).toHaveBeenCalledOnce();
    socket.emit("pong");
    expect(() => locks.assertOwned("project", "figure.drawio", socket.token, "u1")).toThrow();
    expect(acquire().token).not.toBe(socket.token);
  });

  it("reclaims revoked, disconnected or stale leases before granting another owner", () => {
    let valid = true; const first = acquire(new Socket(), "sub/figure.drawio", "u1", () => valid);
    expect(() => locks.assertUnlocked("project", ["sub"])).toThrow();
    valid = false;
    const next = acquire(new Socket(), "sub/figure.drawio", "u2");
    expect(first.terminate).toHaveBeenCalledOnce(); expect(next.token).toBeTypeOf("string");
    next.readyState = 3;
    expect(() => locks.assertUnlocked("project", ["sub"])).not.toThrow();
  });

  it("releases every project lease for restore/deletion, rejects work after shutdown, and keeps no lock across restarts", () => {
    const abandoned = new Socket(); abandoned.readyState = 3; acquire(abandoned);
    expect(abandoned.send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const first = acquire(), other = acquire(new Socket(), "other.drawio");
    locks.revokeProject("project");
    expect(first.terminate).toHaveBeenCalledOnce(); expect(other.terminate).toHaveBeenCalledOnce();
    const current = acquire(); locks.close(); expect(current.terminate).toHaveBeenCalledOnce();
    expect(acquire().close).toHaveBeenCalledWith(1008, "Access denied");
    locks = new DrawioLocks();
    expect(() => locks.assertOwned("project", "figure.drawio", current.token, "u1")).toThrow();
    expect(acquire().token).not.toBe(current.token);
  });
});
